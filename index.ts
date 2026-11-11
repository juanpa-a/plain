#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { cloudAccessProblem } from "./modules/agent";
import { installSkill } from "./modules/install";
import { Orchestrator } from "./modules/orchestrator";
import { readRunReport, RunBlocked, RunFailed, RunLog, type RunStatus } from "./modules/run-log";
import { SpecError, Specs, specJsonSchema, type Repo, type Spec } from "./modules/spec";
import { buildWalkthrough, listCommits, walkthroughJsonSchema } from "./modules/walkthrough";
import { Workspace, type PullRequestResult } from "./modules/workspace";

import { CONFIG_PATH, DEFAULT_SPEC_PATH, EXIT_BLOCKED, EXIT_FAIL, EXIT_INVALID_SPEC, RUNS_DIR } from "./constants";

const HELP = `plain <command> [options]

turns a spec into tasks and implements them with agents, on its own branch and worktree

commands:
  verify [spec]          check the spec against the repo, no agents
  run [spec]             run the agents on the spec
  status <id>            where a run is, as json
  schema                 the spec json schema and an example
  walkthrough <id>       what a run changed and where to build its walkthrough page
  install-skill          install the skill for Claude Code and Cursor

arguments:
  spec                   path to the spec yaml (default: ${DEFAULT_SPEC_PATH})

options:
  --detach               run: start in the background and print the run id
  --data <file>          walkthrough: build the page from this json
  --repo-root <dir>      root of the repository (default: git root)
  --service-root <dir>   where the spec paths are resolved, for monorepos (default: current directory)
  -h, --help             show this help

exit codes: 0 ok, ${EXIT_FAIL} failed, ${EXIT_INVALID_SPEC} invalid spec, ${EXIT_BLOCKED} blocked, needs a human

config: ${CONFIG_PATH}
logs:   ${RUNS_DIR}/<id>/events.jsonl`;

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    detach: { type: "boolean" },
    data: { type: "string" },
    "run-id": { type: "string" }, // internal, how --detach hands the id to the background process
    "repo-root": { type: "string" },
    "service-root": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const [command, target] = args.positionals;

if (args.values.help || !command) {
  console.log(HELP);
  process.exit(0);
}

const gitRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
const repo: Repo = {
  root: resolve(args.values["repo-root"] ?? (gitRoot || process.cwd())),
  service: resolve(args.values["service-root"] ?? process.cwd()),
};
const specPath = target ?? DEFAULT_SPEC_PATH;

switch (command) {
  case "verify":
    await verify();
    break;
  case "run":
    await (args.values.detach ? runDetached() : run(args.values["run-id"] ?? newRunId()));
    break;
  case "status":
    await status();
    break;
  case "walkthrough":
    await walkthrough();
    break;
  case "schema":
    print({ schema: specJsonSchema(), example: await Bun.file(new URL("./spec.example.yaml", import.meta.url)).text() });
    break;
  case "install-skill":
    print(installSkill(Bun.env.HOME ?? "", new URL("./skill/plain", import.meta.url).pathname));
    break;
  default:
    console.error(`unknown command: ${command}\n\n${HELP}`);
    process.exit(EXIT_FAIL);
}

async function checkSpec(): Promise<Spec> {
  const specs = new Specs();
  const spec = await specs.load(specPath);
  await specs.verify(spec, repo); // throws SpecError
  return spec;
}

async function verify(): Promise<void> {
  try {
    await checkSpec();
    print({ ok: true });
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    rejectSpec(error);
  }
}

async function status(): Promise<void> {
  if (!target) {
    console.error("status needs a run id");
    process.exit(EXIT_FAIL);
  }
  const report = await readRunReport(target, `${RUNS_DIR}/${target}`);
  if (!report) {
    console.error(`there is no run ${target}`);
    process.exit(EXIT_FAIL);
  }
  print(report);
}

// without --data: what the run changed and where to work. with it: builds the page
async function walkthrough(): Promise<void> {
  const report = target ? await readRunReport(target, `${RUNS_DIR}/${target}`, Infinity) : null;
  if (!report?.base || !report.branch) {
    console.error(target ? `there is no run ${target} with a branch` : "walkthrough needs a run id");
    process.exit(EXIT_FAIL);
  }
  const dir = `${RUNS_DIR}/${report.id}/walkthrough`;
  mkdirSync(`${dir}/shots`, { recursive: true });

  if (args.values.data) {
    const template = await Bun.file(new URL("./templates/walkthrough.html", import.meta.url)).text();
    let raw: unknown;
    try {
      raw = await Bun.file(args.values.data).json();
    } catch (error) {
      print({ ok: false, errors: [`${args.values.data}: ${(error as Error).message}`] });
      process.exit(EXIT_FAIL);
    }
    const built = await buildWalkthrough(raw, dir, template);
    if (!built.ok) {
      print(built);
      process.exit(EXIT_FAIL);
    }
    await Bun.write(`${dir}/index.html`, built.html);
    print({ ok: true, file: `${dir}/index.html` });
    return;
  }

  print({
    dir,
    shots: `${dir}/shots`,
    base: report.base,
    branch: report.branch,
    pr: report.pr,
    commits: listCommits(repo.service, report.base, report.branch),
    rejections: report.rejections,
    before: `git worktree add --detach ${dir}/before ${report.base}`,
    after: `git worktree add --detach ${dir}/after ${report.branch}`,
    build: `plain walkthrough ${report.id} --data ${dir}/data.json`,
    format: walkthroughJsonSchema(),
  });
}

// everything that can be rejected is rejected here, the caller is still listening
async function runDetached(): Promise<void> {
  try {
    await checkSpec();
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    rejectSpec(error);
  }

  const problem = await startProblem(await Workspace.load(CONFIG_PATH, repo));
  if (problem) {
    print({ ok: false, errors: [problem] });
    process.exit(EXIT_FAIL);
  }

  const id = newRunId();
  const log = new RunLog(`${RUNS_DIR}/${id}`);
  const output = openSync(`${log.getDir()}/output.log`, "a");
  const child = Bun.spawn(
    [process.execPath, Bun.main, "run", resolve(specPath), "--repo-root", repo.root, "--service-root", repo.service, "--run-id", id],
    { stdin: "ignore", stdout: output, stderr: output, detached: true },
  );
  log.write("detached", { pid: child.pid });
  child.unref();
  closeSync(output);

  print({ ok: true, id, pid: child.pid, branch: `plain/${id}`, status: `plain status ${id}` });
}

async function run(id: string): Promise<void> {
  const log = new RunLog(`${RUNS_DIR}/${id}`);
  const workspace = await Workspace.load(CONFIG_PATH, repo);
  let orchestrator: Orchestrator | null = null;
  let pr: PullRequestResult = { url: null, error: null };

  // closes the log and prints the summary
  const finish = (status: RunStatus, message: string): void => {
    if (status === "success") workspace.closeRun();
    const summary = {
      ...(orchestrator?.getSummary() ?? { rounds: 0, tasks: 0, done: 0 }),
      message,
      branch: workspace.getBranch(),
      worktree: workspace.getWorktree(),
      pr: pr.url,
      prError: pr.error,
    };
    log.finish(status, summary);

    console.log(`plain: ${status}`);
    console.log(message);
    console.log(`tasks: ${summary.done}/${summary.tasks} done, ${summary.rounds} round(s)`);
    if (summary.branch) console.log(`branch: ${summary.branch}`);
    if (summary.worktree) console.log(`worktree: ${summary.worktree}`);
    if (summary.pr) console.log(`draft pr: ${summary.pr}`);
    if (summary.prError) console.log(`no draft pr: ${summary.prError}`);
    console.log(`log: ${log.getPath()}`);
  };

  const cancel = (code: number) => async () => {
    await orchestrator?.cancel();
    finish("cancelled", "cancelled by the user");
    process.exit(code);
  };
  process.on("SIGINT", cancel(130));
  process.on("SIGTERM", cancel(143));

  try {
    log.start({ spec: specPath, repo, model: workspace.getModel(), pid: process.pid });

    const spec = await checkSpec();

    const problem = (await startProblem(workspace)) ?? workspace.startRun(id, `${log.getDir()}/worktree`);
    log.write("workspace", { branch: workspace.getBranch(), worktree: workspace.getWorktree(), base: workspace.getBase() });
    if (problem) log.fail(problem);

    orchestrator = new Orchestrator(spec, workspace, log);
    await orchestrator.run();

    pr = workspace.openDraftPr(orchestrator.getPullRequest());
    finish("success", "done");
  } catch (error) {
    if (error instanceof SpecError) {
      log.write("spec-error", { errors: error.errors });
      finish("fail", `the spec is not valid:\n- ${error.errors.join("\n- ")}`);
      process.exit(EXIT_INVALID_SPEC);
    } else if (error instanceof RunBlocked) {
      finish("blocked", error.message);
      process.exit(EXIT_BLOCKED);
    } else if (error instanceof RunFailed) {
      finish("fail", error.message);
    } else {
      log.write("crash", { message: (error as Error).message, stack: (error as Error).stack });
      finish("fail", (error as Error).message);
    }
    process.exit(EXIT_FAIL);
  }
}

// the reason a run can not start, before it touches git or spends anything
async function startProblem(workspace: Workspace): Promise<string | null> {
  const problem = workspace.canStart();
  if (problem) return problem;
  const url = workspace.getRepoUrl();
  return workspace.usesCloud() && url ? cloudAccessProblem(url) : null;
}

function newRunId(): string {
  return String(Date.now());
}

function rejectSpec(error: SpecError): never {
  print({ ok: false, errors: error.errors });
  process.exit(EXIT_INVALID_SPEC);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
