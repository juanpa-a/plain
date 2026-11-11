import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as sdk from "@cursor/sdk";

import { cloudAccessProblem, isAgentLimit, parseVerdict } from "../modules/agent";
import { Orchestrator } from "../modules/orchestrator";
import { RunBlocked, RunFailed, RunLog } from "../modules/run-log";
import type { Spec } from "../modules/spec";
import { Workspace } from "../modules/workspace";
import { fixture } from "./fixture";

type Tools = Record<string, { execute: (args: unknown) => unknown }>;
type Options = { local: { cwd: string; customTools: Tools } };
type CloudOptions = { cloud: { repos: { url: string; startingRef: string }[]; autoCreatePR: boolean } };
type PlannedTask = { id: string; domain: string; dependsOn?: string[] };
type Attempt = { taskId: string; domain: string; number: number; dir: string };
type Verdict = { approved: boolean; notes: string };
type CreateOptions = CloudOptions & { mcpServers?: unknown };

// what the fake models do, each test sets it up
let plan: PlannedTask[] = [];
let blocker: string | null = null;
let origin = ""; // the bare repo behind https://github.com/acme/repo
let cloudWork: (attempt: Attempt) => Promise<void> | void = () => {};
let cloudAnswer: (role: string, taskId: string) => string = () => verdictText({ approved: true, notes: "" });
let finalVerdicts: Verdict[] = [];
let polisherPushes = true;
let cancelled: string[] = [];
let stages: string[] = []; // the cloud agents in the order they got to work
let created: { role: string; startingRef: string; mcp: unknown }[] = [];
let implementorMessages: string[] = [];
let peak = 0;
let active = 0;
let archived: string[] = [];

const GIT = ["-c", "user.email=t@t", "-c", "user.name=t"];
const WRITERS = ["implementor", "polisher"];
let agents = 0;

function verdictText(verdict: Verdict): string {
  return "my analysis\n```json\n" + JSON.stringify(verdict) + "\n```";
}

async function fakeCloudAgent(options: CreateOptions): Promise<unknown> {
  const { startingRef } = options.cloud.repos[0]!;
  const id = `bc-${++agents}`;
  const dir = mkdtempSync(join(tmpdir(), "plain-cloud-"));
  await Bun.$`git clone -q --branch ${startingRef} ${origin} ${dir}`.quiet();
  await Bun.$`git checkout -q -b cursor/${id}`.cwd(dir);
  let number = 0;
  let role = "";

  return {
    agentId: id,
    close: () => {},
    send: async (message: string) => {
      if (!role) {
        role = message.match(/^# ([\w-]+)/)?.[1] ?? "";
        created.push({ role, startingRef, mcp: options.mcpServers });
      }
      if (role === "implementor") implementorMessages.push(message);
      const taskId = message.match(/task: (t\d+)/)?.[1] ?? "";
      const domain = message.match(/domain: (\S+)/)?.[1] ?? "";
      const target = message.match(/HEAD:refs\/heads\/(\S+)/)?.[1];
      stages.push(`${role}:${taskId}`);
      let finished = false;
      return {
        id: `run-${id}`,
        cancel: async () => {
          if (!finished) cancelled.push(`${role}:${taskId}`);
        },
        wait: async () => {
          if (role === "implementor") peak = Math.max(peak, ++active);
          await Bun.sleep(30); // long enough for the others to start
          number++;
          if (role === "implementor") await cloudWork({ taskId, domain, number, dir });
          const pushes = role === "implementor" || (role === "polisher" && polisherPushes);
          if (pushes) {
            await Bun.write(join(dir, domain, `${role}-${taskId}-${number}.txt`), "built\n");
            await Bun.$`git add -A && git ${GIT} commit -q -m work && git push -q -f origin HEAD:refs/heads/${target}`.cwd(dir).quiet();
          }
          if (role === "implementor") active--;
          finished = true;
          // like the real sdk, it does not report what was pushed
          return { id: `run-${id}`, status: "finished", result: WRITERS.includes(role) ? "done" : cloudAnswer(role, taskId), git: { branches: [] } };
        },
      };
    },
  };
}

mock.module("@cursor/sdk", () => ({
  ...sdk,
  Agent: {
    create: fakeCloudAgent,
    archive: async (id: string) => {
      archived.push(id);
    },
    prompt: async (message: string, options: Options) => {
      const tools = options.local.customTools;
      if (message.includes("# BREAK_INTO_TASKS")) {
        for (const task of plan) tools.addTask!.execute({ ...task, description: `${task.id} the file\nmore detail`, for: ["s1"] });
        if (blocker) tools.addBlocker!.execute({ reason: blocker, abstractions: ["src"] });
      } else if (message.includes("# REFINE_TASK_DEFINITION")) {
        const id = message.match(/task: \{"id":"(t\d+)"/)?.[1];
        tools.refineTask!.execute({ id, description: `${id} the file`, intent: [{ id: "s1", given: "g", when: "w", then: "t" }] });
      } else if (message.startsWith("# implementor")) {
        const task = plan[0]!;
        await Bun.write(join(options.local.cwd, task.domain, "built.txt"), "built\n");
      } else if (tools.submitVerdict) {
        tools.submitVerdict.execute((message.includes("env detail") ? finalVerdicts.shift() : undefined) ?? { approved: true, notes: "" });
      }
      return { status: "finished", result: "ok" };
    },
  },
}));

const SPEC: Spec = {
  feature: "f",
  intent: [{ id: "s1", given: "g", when: "w", then: "t" }],
  acceptance: [],
  types: [],
  modules: ["src/a", "src/b", "src/c"].map((path) => ({ path, changes: [{ add: "x", signature: "() => void", for: ["s1"] }] })),
};

async function start(config: object): Promise<{ service: string; workspace: Workspace; log: RunLog }> {
  const service = await fixture({ "src/a/AGENTS.md": "# a\n", "src/b/AGENTS.md": "# b\n", "src/c/AGENTS.md": "# c\n", "shared.txt": "base\n" });
  origin = mkdtempSync(join(tmpdir(), "plain-origin-"));
  await Bun.$`git init -q --bare ${origin}`.quiet();
  await Bun.$`git init -q && git add . && git ${GIT} commit -q -m init`.cwd(service);
  await Bun.$`git config user.email t@t && git config user.name t`.cwd(service);
  await Bun.$`git remote add origin https://github.com/acme/repo.git && git config url.${origin}.insteadOf https://github.com/acme/repo.git`.cwd(service);

  const dir = await fixture({ "config.json": JSON.stringify(config) });
  const workspace = await Workspace.load(join(dir, "config.json"), { root: service, service });
  const log = new RunLog(join(dir, "run"));
  expect(workspace.startRun("1", join(dir, "worktree"))).toBeNull();
  return { service, workspace, log };
}

const events = async (log: RunLog): Promise<{ step: string; data: any }[]> =>
  (await Bun.file(log.getPath()).text()).trim().split("\n").map((line) => JSON.parse(line));

beforeEach(() => {
  blocker = null;
  cancelled = [];
  stages = [];
  created = [];
  implementorMessages = [];
  finalVerdicts = [];
  polisherPushes = true;
  cloudAnswer = () => verdictText({ approved: true, notes: "" });
  peak = 0;
  active = 0;
  archived = [];
  cloudWork = () => {};
  plan = [{ id: "t1", domain: "src/a" }];
});

describe("local implementors", () => {
  test("commits the approved task on the run branch, the checkout stays as it was", async () => {
    const { service, workspace, log } = await start({ implementors: "local" });
    const orchestrator = new Orchestrator(SPEC, workspace, log);

    await orchestrator.run();

    expect(orchestrator.getSummary()).toEqual({ rounds: 1, tasks: 1, done: 1 });
    expect(await Bun.$`git show plain/1:src/a/built.txt`.cwd(service).text()).toBe("built\n");
    expect(await Bun.$`git log -1 --format=%s plain/1`.cwd(service).text()).toBe("plain: t1 t1 the file\n");
    expect(await Bun.file(join(service, "src/a/built.txt")).exists()).toBe(false);
    expect((await events(log)).findLast((event) => event.step === "todo")?.data.tasks).toEqual([
      { id: "t1", domain: "src/a", title: "t1 the file", isDone: true, isRunning: false },
    ]);
  });

  test("a blocker stops the run as blocked, before implementing", async () => {
    blocker = "the abstractions can not express it";
    const { workspace, log } = await start({ implementors: "local" });

    await expect(new Orchestrator(SPEC, workspace, log).run()).rejects.toThrow(RunBlocked);
    expect(await Bun.file(join(workspace.getServiceRoot(), "src/a/built.txt")).exists()).toBe(false);
  });

  test("a plan with no tasks fails instead of reviewing nothing", async () => {
    plan = [];
    const { workspace, log } = await start({ implementors: "local" });

    await expect(new Orchestrator(SPEC, workspace, log).run()).rejects.toThrow("the arquitect created no tasks");
  });
});

describe("cloud implementors", () => {
  const remoteFiles = async (): Promise<string> => Bun.$`git ls-tree -r --name-only plain/1`.cwd(origin).text();

  test("independent tasks run at the same time and land squashed on the pushed run branch", async () => {
    plan = [{ id: "t1", domain: "src/a" }, { id: "t2", domain: "src/b" }, { id: "t3", domain: "src/c" }];
    const { service, workspace, log } = await start({});
    const orchestrator = new Orchestrator(SPEC, workspace, log);

    await orchestrator.run();

    expect(peak).toBe(3);
    expect(orchestrator.getSummary().done).toBe(3);
    expect(orchestrator.getPullRequest()).toEqual({
      title: "f",
      body: "## Scenarios\n- **s1**: given g, when w, then t\n\n## Tasks\n- `src/a` t1 the file\n- `src/b` t2 the file\n- `src/c` t3 the file",
    });
    expect(await remoteFiles()).toContain("src/c/implementor-t3-1.txt");
    expect(Number(await Bun.$`git rev-list --count plain/1`.cwd(origin).text())).toBe(4); // init + one per task
    expect(await Bun.$`git branch --list plain/1`.cwd(service).text()).toContain("plain/1");
  });

  test("respects the concurrency limit", async () => {
    plan = [{ id: "t1", domain: "src/a" }, { id: "t2", domain: "src/b" }, { id: "t3", domain: "src/c" }];
    const { workspace, log } = await start({ concurrency: 2 });
    await new Orchestrator(SPEC, workspace, log).run();
    expect(peak).toBe(2);
  });

  test("a task waits for its dependencies and starts from their result", async () => {
    plan = [{ id: "t1", domain: "src/a" }, { id: "t2", domain: "src/b", dependsOn: ["t1"] }];
    let seen = false;
    cloudWork = async ({ taskId, dir }) => {
      if (taskId === "t2") seen = await Bun.file(join(dir, "src/a/implementor-t1-1.txt")).exists();
    };
    const { workspace, log } = await start({});

    await new Orchestrator(SPEC, workspace, log).run();

    expect(peak).toBe(1);
    expect(seen).toBe(true);
  });

  test("two tasks in one domain do not overlap", async () => {
    plan = [{ id: "t1", domain: "src/a" }, { id: "t2", domain: "src/a" }];
    const { workspace, log } = await start({});
    await new Orchestrator(SPEC, workspace, log).run();
    expect(peak).toBe(1);
  });

  test("a branch that leaves the domain goes back to the agent and nothing of it lands", async () => {
    cloudWork = async ({ number, dir }) => {
      if (number === 1) await Bun.write(join(dir, "shared.txt"), "touched\n");
      else await Bun.$`git checkout -q origin/plain/1 -- shared.txt`.cwd(dir).quiet();
    };
    const { workspace, log } = await start({});

    await new Orchestrator(SPEC, workspace, log).run();

    const refused = (await events(log)).filter((event) => event.step === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.data.reason).toContain("shared.txt");
    expect(await Bun.$`git show plain/1:shared.txt`.cwd(origin).text()).toBe("base\n");
  });

  test("a conflict goes back to the agent, and its rebased work lands on a clean worktree", async () => {
    const { workspace, log } = await start({});
    const worktree = workspace.getServiceRoot();
    cloudWork = async ({ number, dir }) => {
      if (number === 1) {
        await Bun.write(join(dir, "src/a/AGENTS.md"), "from the agent\n");
        await Bun.write(join(worktree, "src/a/AGENTS.md"), "from the run\n");
        await Bun.$`git add -A && git ${GIT} commit -q -m other && git push -q origin plain/1`.cwd(worktree).quiet();
      } else {
        await Bun.$`git fetch -q origin plain/1 && git reset -q --hard FETCH_HEAD`.cwd(dir).quiet();
      }
    };
    const orchestrator = new Orchestrator(SPEC, workspace, log);

    await orchestrator.run();

    const refused = (await events(log)).filter((event) => event.step === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.data.reason).toContain("conflicts with plain/1");
    expect(orchestrator.getSummary().done).toBe(1);
    expect(await Bun.$`git show plain/1:src/a/AGENTS.md`.cwd(origin).text()).toBe("from the run\n");
    expect(await Bun.$`git status --porcelain`.cwd(worktree).text()).toBe("");
  });

  test("each task goes through polish, quality, performance and qa in the cloud, in that order", async () => {
    const { workspace, log } = await start({ mcpServers: { browser: { url: "https://x" } } });

    await new Orchestrator(SPEC, workspace, log).run();

    expect(stages).toEqual(["implementor:t1", "polisher:t1", "quality-reviewer:t1", "performance-reviewer:t1", "qa:t1"]);
    expect(await remoteFiles()).toContain("src/a/polisher-t1-1.txt"); // what lands is the polished version

    const [implementor, polisher, quality, performance, qa] = created;
    expect(implementor?.startingRef).toBe("plain/1");
    expect(polisher?.startingRef).toBe("plain/1-implementor-t1");
    expect(quality?.startingRef).toBe("plain/1-polisher-t1");
    expect(quality?.startingRef).not.toBe(polisher?.startingRef as string); // reviews what polish left
    expect(performance?.startingRef).toBe(quality?.startingRef as string);
    expect(qa?.mcp).toEqual({ browser: { url: "https://x" } });
    expect(archived).toHaveLength(created.length); // none keeps a slot of the plan
    expect(quality?.mcp).toBeUndefined();

    const prompted = (await events(log)).filter((event) => event.step === "prompt").map((event) => event.data.agent);
    expect(prompted).not.toContain("reviewer:t1"); // nothing per task reviews locally
    expect(prompted).not.toContain("verifier:t1");
  });

  test("a rejection stops the round and its notes go back to the same implementor", async () => {
    let rejected = false;
    cloudAnswer = (role) => {
      if (role === "performance-reviewer" && !rejected) {
        rejected = true;
        return verdictText({ approved: false, notes: "n+1 in the loop" });
      }
      return verdictText({ approved: true, notes: "" });
    };
    const { workspace, log } = await start({});

    await new Orchestrator(SPEC, workspace, log).run();

    expect(stages).toEqual([
      "implementor:t1", "polisher:t1", "quality-reviewer:t1", "performance-reviewer:t1",
      "implementor:t1", "polisher:t1", "quality-reviewer:t1", "performance-reviewer:t1", "qa:t1",
    ]);
    expect(created.filter((agent) => agent.role === "implementor")).toHaveLength(1);
    expect(implementorMessages[1]).toContain("n+1 in the loop");
    expect(implementorMessages[1]).toContain("git pull --ff-only origin plain/1-polisher-t1");
  });

  test("when polish finds nothing to change the implementor's branch is what gets reviewed", async () => {
    polisherPushes = false;
    const { workspace, log } = await start({});

    await new Orchestrator(SPEC, workspace, log).run();

    expect(created.find((agent) => agent.role === "quality-reviewer")?.startingRef).toBe(created.find((agent) => agent.role === "polisher")?.startingRef as string);
    expect(await remoteFiles()).toContain("src/a/implementor-t1-1.txt");
  });

  test("an answer without a verdict counts as a rejection", async () => {
    cloudAnswer = (role) => (role === "quality-reviewer" ? "looks fine to me" : verdictText({ approved: true, notes: "" }));
    const { workspace, log } = await start({});

    await expect(new Orchestrator(SPEC, workspace, log).run()).rejects.toThrow("task t1 did not converge");
    expect(stages.filter((stage) => stage.startsWith("qa"))).toHaveLength(0);
  });

  test("the final verification runs locally over the whole run and can send it back", async () => {
    const { workspace, log } = await start({});
    finalVerdicts = [{ approved: false, notes: "the flow breaks end to end" }, { approved: true, notes: "" }];
    const orchestrator = new Orchestrator(SPEC, workspace, log);

    await orchestrator.run();

    expect(orchestrator.getSummary().rounds).toBe(2);
    const all = await events(log);
    expect(all.filter((event) => event.step === "prompt" && event.data.agent === "final-verifier")).toHaveLength(2);
    const recategorize = all.find((event) => event.step === "prompt" && event.data.step === "RECATEGORIZE_FEEDBACK");
    expect(recategorize?.data.message).toContain("the flow breaks end to end");
  });

  test("when one task fails the others are cancelled", async () => {
    plan = [{ id: "t1", domain: "src/a" }, { id: "t2", domain: "src/b" }];
    cloudWork = async ({ taskId }) => {
      if (taskId === "t1") throw new RunFailed("boom");
      await Bun.sleep(300);
    };
    const { workspace, log } = await start({});

    await expect(new Orchestrator(SPEC, workspace, log).run()).rejects.toThrow("boom");
    expect(cancelled).toContain("implementor:t2");
  });
});

describe("the repository url for the cloud", () => {
  const url = async (remote: string): Promise<string | null> => {
    const service = await fixture({ "a.txt": "x" });
    await Bun.$`git init -q && git remote add origin ${remote}`.cwd(service);
    const dir = await fixture({ "config.json": "{}" });
    return (await Workspace.load(join(dir, "config.json"), { root: service, service })).getRepoUrl();
  };

  test("understands ssh and https, and refuses a local path", async () => {
    expect(await url("git@github.com:acme/repo.git")).toBe("https://github.com/acme/repo");
    expect(await url("ssh://git@github.com/acme/repo.git")).toBe("https://github.com/acme/repo");
    expect(await url("https://github.com/acme/repo")).toBe("https://github.com/acme/repo");
    expect(await url("/tmp/repo.git")).toBeNull();
  });
});

describe("cloud access", () => {
  const URL = "https://github.com/acme/repo";

  test("a repository Cursor has connected is fine, whatever the case or suffix", async () => {
    expect(await cloudAccessProblem(URL, async () => [{ url: "https://github.com/Acme/repo.git" }])).toBeNull();
  });

  test("a repository Cursor can not see stops the run before it starts", async () => {
    expect(await cloudAccessProblem(URL, async () => [])).toContain("Cursor can not reach https://github.com/acme/repo");
    expect(await cloudAccessProblem(URL, async () => Promise.reject(new Error("401")))).toContain("401");
  });
});

test("the agent limit of the plan is told apart from other errors", () => {
  expect(isAgentLimit("[validation_error] Upgrade to Ultra for more Cloud Agents: You've reached the limit for your current plan.")).toBe(true);
  expect(isAgentLimit("[validation_error] Failed to verify existence of branch")).toBe(false);
});

describe("parseVerdict", () => {
  test("takes the last verdict block of the message", () => {
    const text = '```json\n{"approved":true,"notes":"draft"}\n```\nthinking more\n```json\n{"approved":false,"notes":"final"}\n```';
    expect(parseVerdict(text)).toEqual({ approved: false, notes: "final" });
  });

  test("anything else is a rejection", () => {
    expect(parseVerdict("all good").approved).toBe(false);
    expect(parseVerdict('```json\n{"approved":"yes"}\n```').approved).toBe(false);
  });
});
