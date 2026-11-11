import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Workspace } from "../modules/workspace";
import { fixture } from "./fixture";

async function gitService(): Promise<string> {
  const dir = await fixture({ "README.md": "hi\n" });
  await Bun.$`git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git add . && git -c user.email=t@t -c user.name=t commit -q -m readme`.cwd(dir);
  return dir;
}

async function workspace(service: string, config: object = {}): Promise<Workspace> {
  const dir = await fixture({ "config.json": JSON.stringify({ implementors: "local", ...config }) });
  return Workspace.load(join(dir, "config.json"), { root: service, service });
}

describe("config", () => {
  test("missing fields fall back to the defaults", async () => {
    const ws = await workspace("/tmp", { checks: ["true"] });
    expect(ws.getModel()).toBe("kimi-k3");
    expect(ws.getMcpServers()).toEqual({});
  });
});

describe("checks", () => {
  test("returns only the failed commands, run in the service root", async () => {
    const service = await fixture({ "marker.txt": "here" });
    const ws = await workspace(service, { checks: ["test -f marker.txt", "echo broken && exit 1"] });
    expect(ws.runChecks()).toEqual([{ command: "echo broken && exit 1", output: "broken\n" }]);
  });
});

describe("draft pr", () => {
  const PR = { title: "Download invoice", body: "the body" };

  // a fake gh on the PATH that records what it was called with
  async function fakeGh(script: string): Promise<string> {
    const bin = await fixture({ "gh": `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/args"\n${script}\n` });
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    return bin;
  }

  async function withOrigin(): Promise<{ ws: Workspace; bare: string }> {
    const service = await gitService();
    const bare = mkdtempSync(join(tmpdir(), "plain-origin-"));
    await Bun.$`git init -q --bare ${bare}`.quiet();
    await Bun.$`git remote add origin https://github.com/acme/repo.git && git config url.${bare}.insteadOf https://github.com/acme/repo.git`.cwd(service);
    const ws = await workspace(service, { implementors: "cloud" });
    expect(ws.startRun("9", join(mkdtempSync(join(tmpdir(), "plain-run-")), "worktree"))).toBeNull();
    return { ws, bare };
  }

  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  test("pushes the branch and opens it as a draft against the branch the run came from", async () => {
    const bin = await fakeGh("echo 'Creating pull request'; echo https://github.com/acme/repo/pull/5");
    const { ws, bare } = await withOrigin();
    const current = (await Bun.$`git symbolic-ref --short HEAD`.cwd(ws.getServiceRoot()).text()).trim();
    expect(current).toBe("plain/9");

    await Bun.write(join(ws.getServiceRoot(), "a.txt"), "task\n");
    ws.commit("task");
    expect(ws.openDraftPr(PR)).toEqual({ url: "https://github.com/acme/repo/pull/5", error: null });

    expect(await Bun.$`git show plain/9:a.txt`.cwd(bare).text()).toBe("task\n");
    const args = (await Bun.file(join(bin, "args")).text()).trim().split("\n");
    expect(args.slice(0, 5)).toEqual(["pr", "create", "--draft", "--head", "plain/9"]);
    expect(args[5]).toBe("--base");
    expect(args[6]).toMatch(/^(main|master)$/);
    expect(args.slice(7)).toEqual(["--title", "Download invoice", "--body", "the body"]);
  });

  test("a failing gh is reported, not thrown", async () => {
    await fakeGh("echo 'not logged in' >&2; exit 1");
    const { ws } = await withOrigin();
    expect(ws.openDraftPr(PR)).toEqual({ url: null, error: "gh pr create failed: not logged in" });
  });

  test("without a hosted origin there is nothing to open it on", async () => {
    const ws = await workspace(await gitService());
    expect(ws.startRun("1", join(mkdtempSync(join(tmpdir(), "plain-run-")), "worktree"))).toBeNull();
    expect(ws.openDraftPr(PR)).toEqual({ url: null, error: "no hosted origin, the branch stayed local" });
  });
});

describe("git", () => {
  const start = (ws: Workspace, id = "1"): string | null => ws.startRun(id, join(mkdtempSync(join(tmpdir(), "plain-run-")), "worktree"));

  test("refuses to start with uncommitted changes in tracked files", async () => {
    const service = await gitService();
    await Bun.write(join(service, "README.md"), "changed\n");
    expect(start(await workspace(service))).toBe("the working tree has uncommitted changes");
  });

  test("cloud implementors need a remote they can clone", async () => {
    const service = await gitService();
    const ws = await workspace(service, { implementors: "cloud" });
    expect(ws.canStart()).toBe("cloud implementors need an origin remote on a hosted repository");
  });

  test("an untracked spec does not stop the run", async () => {
    const service = await gitService();
    await Bun.write(join(service, "specs/ticket.yaml"), "feature: x\n");
    expect(start(await workspace(service))).toBeNull();
  });

  test("the run works on its own branch and leaves the checkout alone", async () => {
    const service = await gitService();
    const ws = await workspace(service);
    expect(start(ws, "42")).toBeNull();
    expect(ws.getBranch()).toBe("plain/42");

    await Bun.write(join(ws.getServiceRoot(), "a.txt"), "task\n");
    ws.commit("task");

    expect(existsSync(join(service, "a.txt"))).toBe(false);
    expect((await Bun.$`git branch --show-current`.cwd(service).text()).trim()).not.toBe("plain/42");
    expect(await Bun.$`git show plain/42:a.txt`.cwd(service).text()).toBe("task\n");
  });

  test("the service root keeps its place inside the worktree, for monorepos", async () => {
    const root = await fixture({ "services/billing/README.md": "hi\n" });
    await Bun.$`git init -q && git add . && git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(root);
    const config = await fixture({ "config.json": '{ "implementors": "local" }' });
    const ws = await Workspace.load(join(config, "config.json"), { root, service: join(root, "services/billing") });

    expect(start(ws)).toBeNull();
    expect(existsSync(join(ws.getServiceRoot(), "README.md"))).toBe(true);
    expect(ws.getServiceRoot()).toEndWith("worktree/services/billing");
  });

  test("setup runs in the worktree and its failure stops the run", async () => {
    const ok = await workspace(await gitService(), { setup: ["touch installed.marker"] });
    expect(start(ok)).toBeNull();
    expect(existsSync(join(ok.getServiceRoot(), "installed.marker"))).toBe(true);

    const broken = await workspace(await gitService(), { setup: ["echo nope && exit 1"] });
    expect(start(broken)).toBe("setup failed: echo nope && exit 1\nnope\n");
  });

  test("closing removes a clean worktree and keeps the branch", async () => {
    const service = await gitService();
    const ws = await workspace(service);
    expect(start(ws, "7")).toBeNull();
    const worktree = ws.getWorktree() as string;
    await Bun.write(join(worktree, "a.txt"), "task\n");
    ws.commit("task");

    ws.closeRun();
    expect(ws.getWorktree()).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect(await Bun.$`git show plain/7:a.txt`.cwd(service).text()).toBe("task\n");
  });

  test("closing keeps a worktree with leftovers", async () => {
    const ws = await workspace(await gitService());
    expect(start(ws)).toBeNull();
    const worktree = ws.getWorktree() as string;
    await Bun.write(join(worktree, "leftover.txt"), "x");

    ws.closeRun();
    expect(ws.getWorktree()).toBe(worktree);
    expect(existsSync(join(worktree, "leftover.txt"))).toBe(true);
  });

  test("the task diff is what changed since the last commit, the run diff everything since the start", async () => {
    const ws = await workspace(await gitService());
    expect(start(ws)).toBeNull();
    const service = ws.getServiceRoot();

    await Bun.write(join(service, "a.txt"), "first task\n");
    expect(ws.getTaskDiff()).toContain("+first task");
    await Bun.$`git -c user.email=t@t -c user.name=t commit -q -am "task 1"`.cwd(service);

    await Bun.write(join(service, "b.txt"), "second task\n");
    const taskDiff = ws.getTaskDiff();
    expect(taskDiff).toContain("+second task");
    expect(taskDiff).not.toContain("first task");

    const runDiff = ws.getRunDiff();
    expect(runDiff).toContain("+first task");
    expect(runDiff).toContain("+second task");
  });
});
