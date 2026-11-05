#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { Agent } from "./modules/agent";
import { Domains } from "./modules/domain";
import { RunFailed, RunLog } from "./modules/run-log";
import { SpecError, Specs, type Repo } from "./modules/spec";
import { Todo, type Task } from "./modules/todo";
import { Workspace } from "./modules/workspace";

import { Rules, steps } from "./prompts";
import { CONFIG_PATH, DEFAULT_SPEC_PATH, MAX_ATTEMPTS, RUNS_DIR } from "./constants";

const HELP = `plain <spec> [options]

turns a spec into tasks and implements them with agents, committing each task on the current branch

arguments:
  spec                   path to the spec yaml (default: ${DEFAULT_SPEC_PATH})

options:
  --repo-root <dir>      root of the repository (default: git root)
  --service-root <dir>   where the spec paths are resolved, for monorepos (default: current directory)
  -h, --help             show this help

config: ${CONFIG_PATH}
logs:   ${RUNS_DIR}/<timestamp>/events.jsonl`;

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "repo-root": { type: "string" },
    "service-root": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (args.values.help) {
  console.log(HELP);
  process.exit(0);
}

const gitRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
const repo: Repo = {
  root: args.values["repo-root"] ?? (gitRoot || process.cwd()),
  service: args.values["service-root"] ?? process.cwd(),
};
const specPath = args.positionals[0] ?? DEFAULT_SPEC_PATH;

const log = new RunLog(`${RUNS_DIR}/${Date.now()}`);
const workspace = await Workspace.load(CONFIG_PATH, repo);
let rounds = 0;
let todo: Todo | null = null;

process.on("SIGINT", () => {
  finish("cancelled", "cancelled by the user");
  process.exit(130);
});

try {
  log.start({ spec: specPath, repo, model: workspace.getModel() });

  const problem = workspace.startRun();
  if (problem) log.fail(problem);

  const specs = new Specs();
  const spec = await specs.load(specPath);
  await specs.verify(spec, repo); // throws SpecError

  const domains = new Domains(repo.service);
  const rules = new Rules(domains);
  const modulePaths = new Set(spec.modules.map((module) => module.path));
  todo = new Todo({
    isKnownDomain: (domain) => domains.exists(domain) || modulePaths.has(domain),
    scenarioIds: new Set(spec.intent.map((scenario) => scenario.id)),
  });
  const run: Todo = todo;

  const arquitect = new Agent(rules.arquitect(), log, workspace, { label: "arquitect", tools: run.getTools() });
  const categorizer = new Agent(rules.categorizer(), log, workspace, { label: "categorizer", tools: run.getTools() });
  const finalReviewer = new Agent(rules.finalReviewer(), log, workspace, { label: "final-reviewer" });

  async function plan(): Promise<void> {
    const plan = await arquitect.prompt("PLAN", `
      ${steps.PLAN}

      spec: ${JSON.stringify(spec)}
    `);

    await arquitect.prompt("BREAK_INTO_TASKS", `
      ${steps.BREAK_INTO_TASKS}

      plan: ${plan}
    `);
  }

  async function groom(): Promise<void> {
    let rounds = 0;
    while (!run.isFullyGroomed() && !run.hasBlocker()) {
      if (rounds++ >= MAX_ATTEMPTS) log.fail("grooming did not converge");

      for (const task of run.getTasks().filter((task) => !task.isGroomed)) {
        await categorizer.prompt("REFINE_TASK_DEFINITION", `
          ${steps.REFINE_TASK_DEFINITION}

          task: ${JSON.stringify(task)}
          spec: ${JSON.stringify(spec)}
        `);
      }

      for (const issue of run.getIssues()) {
        await categorizer.prompt("RETHINK_TASK", `
          ${steps.RETHINK_TASK}

          issue: ${JSON.stringify(issue)}
          task: ${JSON.stringify(run.getTask(issue.parentTaskId))}
          spec: ${JSON.stringify(spec)}
        `);
      }
    }

    if (run.hasBlocker()) {
      log.fail(run.explainBlocker()); // raise to human
    }
  }

  async function implement(): Promise<void> {
    for (const task of run.getTasks().filter((task) => !task.isDone)) {
      const label = (role: string): string => `${role}:${task.id}`;
      const implementor = new Agent(await rules.implementor(task.domain), log, workspace, {
        label: label("implementor"),
        access: { kind: "domain", domain: task.domain },
      });
      const reviewer = new Agent(await rules.reviewer(task.domain), log, workspace, { label: label("reviewer") });
      const verifier = new Agent(rules.verifier(task.intent, spec.acceptance), log, workspace, {
        label: label("verifier"),
        access: { kind: "host" },
        mcp: true,
      });

      let attempts = 0;
      while (!task.review?.approved || !task.qa?.approved) {
        if (attempts++ >= MAX_ATTEMPTS) log.fail(`task ${task.id} did not converge`);

        await implementor.prompt("IMPLEMENT", `
          task: ${task.description}
          domain: ${task.domain}
          intent: ${JSON.stringify(task.intent)}
          reviewer notes: ${task.review?.notes ?? ""}
          qa notes: ${task.qa?.notes ?? ""}
        `);

        task.review = await reviewer.judge("REVIEW_TASK", `
          task: ${task.description}
          diff: ${workspace.getTaskDiff()}
        `);

        task.qa = await verifier.judge("VERIFY_TASK", `
          env detail: ${workspace.getEnvDetails()}
        `);
      }

      workspace.commit(commitMessage(task));
      run.markDone(task.id);
    }
  }

  // returns true when the user checks and the full review pass,
  // otherwise sends the feedback back to the categorizer
  async function finalReview(): Promise<boolean> {
    const failures = workspace.runChecks();
    log.write("checks", { failures });

    const verdict = await finalReviewer.judge("REVIEW", `
      ${steps.REVIEW}

      spec: ${JSON.stringify(spec)}
      diff: ${workspace.getRunDiff()}
    `);

    if (failures.length === 0 && verdict.approved) return true;

    await categorizer.prompt("RECATEGORIZE_FEEDBACK", `
      ${steps.RECATEGORIZE_FEEDBACK}

      failures: ${JSON.stringify(failures)}
      review: ${verdict.notes}
      tasks: ${JSON.stringify(run.getTasks())}
    `);
    return false;
  }

  await plan();

  while (true) {
    if (rounds++ >= MAX_ATTEMPTS) log.fail("final review did not converge");

    await groom();
    await implement();
    if (await finalReview()) break;
  }

  finish("success", "done");
} catch (error) {
  if (error instanceof SpecError) {
    log.write("spec-error", { errors: error.errors });
    finish("fail", `the spec is not valid:\n- ${error.errors.join("\n- ")}`);
  } else if (error instanceof RunFailed) {
    finish("fail", error.message);
  } else {
    log.write("crash", { message: (error as Error).message, stack: (error as Error).stack });
    finish("fail", (error as Error).message);
  }
  process.exit(1);
}

function commitMessage(task: Task): string {
  const title = task.description.split("\n")[0]?.slice(0, 72) ?? "";
  return `plain: ${task.id} ${title}\n\n${task.description}`;
}

// closes the log and prints the summary
function finish(status: "success" | "fail" | "cancelled", message: string): void {
  const tasks = todo?.getTasks() ?? [];
  const summary = {
    rounds,
    tasks: tasks.length,
    done: tasks.filter((task) => task.isDone).length,
    message,
  };
  log.finish(status, summary);

  console.log(`plain: ${status}`);
  console.log(message);
  console.log(`tasks: ${summary.done}/${summary.tasks} done, ${rounds} round(s)`);
  console.log(`log: ${log.getPath()}`);
}
