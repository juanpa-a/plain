import { Rules, steps } from "../prompts";
import { MAX_ATTEMPTS } from "../constants";
import { Agent, CloudAgent } from "./agent";
import { Domains } from "./domain";
import type { RunLog } from "./run-log";
import type { Spec } from "./spec";
import { Todo, type Task } from "./todo";
import type { PullRequest, Workspace } from "./workspace";

export type RunSummary = {
  rounds: number;
  tasks: number;
  done: number;
};

// takes a verified spec to approved commits, the workspace has to be started
export class Orchestrator {
  private rounds = 0;
  private todo: Todo;
  private rules: Rules;
  private arquitect: Agent;
  private categorizer: Agent;
  private finalReviewer: Agent;
  private finalVerifier: Agent;
  private running = new Map<string, Task>(); // the tasks being worked on in the cloud
  private cloudAgents = new Set<CloudAgent>();
  private gate: Promise<unknown> = Promise.resolve(); // the worktree only fits one task at a time

  constructor(
    private spec: Spec,
    private workspace: Workspace,
    private log: RunLog,
  ) {
    const domains = new Domains(workspace.getServiceRoot());
    const modulePaths = new Set(spec.modules.map((module) => module.path));
    this.rules = new Rules(domains);
    this.todo = new Todo({
      isKnownDomain: (domain) => domains.exists(domain) || modulePaths.has(domain),
      scenarioIds: new Set(spec.intent.map((scenario) => scenario.id)),
    });
    this.arquitect = new Agent(this.rules.arquitect(), log, workspace, { label: "arquitect", tools: this.todo.getTools() });
    this.categorizer = new Agent(this.rules.categorizer(), log, workspace, { label: "categorizer", tools: this.todo.getTools() });
    this.finalReviewer = new Agent(this.rules.finalReviewer(), log, workspace, { label: "final-reviewer" });
    this.finalVerifier = new Agent(this.rules.verifier(spec.intent, spec.acceptance), log, workspace, {
      label: "final-verifier",
      access: { kind: "host" },
      mcp: true,
    });
  }

  public async run(): Promise<void> {
    await this.plan();

    while (true) {
      if (this.rounds++ >= MAX_ATTEMPTS) this.log.fail("final review did not converge");

      await this.groom();
      await this.implement();
      if (await this.finalReview()) break;
    }
  }

  public getSummary(): RunSummary {
    const tasks = this.todo.getTasks();
    return { rounds: this.rounds, tasks: tasks.length, done: tasks.filter((task) => task.isDone).length };
  }

  public getPullRequest(): PullRequest {
    const scenarios = this.spec.intent.map((item) => `- **${item.id}**: given ${item.given}, when ${item.when}, then ${item.then}`);
    const tasks = this.todo.getTasks().map((task) => `- \`${task.domain}\` ${title(task)}`);
    return {
      title: this.spec.feature,
      body: ["## Scenarios", ...scenarios, "", "## Tasks", ...tasks].join("\n"),
    };
  }

  // stops the cloud agents, a run that ends has to leave nothing spending
  public async cancel(): Promise<void> {
    await Promise.allSettled([...this.cloudAgents].map((agent) => agent.cancel()));
  }

  private async plan(): Promise<void> {
    const plan = await this.arquitect.prompt("PLAN", `
      ${steps.PLAN}

      spec: ${JSON.stringify(this.spec)}
    `);

    await this.arquitect.prompt("BREAK_INTO_TASKS", `
      ${steps.BREAK_INTO_TASKS}

      plan: ${plan}
    `);
    this.snapshot();
    // a model that writes its tool calls as text leaves the todo empty, nothing would get built
    if (this.todo.getTasks().length === 0) this.log.fail("the arquitect created no tasks");
  }

  private async groom(): Promise<void> {
    let rounds = 0;
    while (!this.todo.isFullyGroomed() && !this.todo.hasBlocker()) {
      if (rounds++ >= MAX_ATTEMPTS) this.log.fail("grooming did not converge");

      for (const task of this.todo.getTasks().filter((task) => !task.isGroomed)) {
        await this.categorizer.prompt("REFINE_TASK_DEFINITION", `
          ${steps.REFINE_TASK_DEFINITION}

          task: ${JSON.stringify(task)}
          spec: ${JSON.stringify(this.spec)}
        `);
      }

      for (const issue of this.todo.getIssues()) {
        await this.categorizer.prompt("RETHINK_TASK", `
          ${steps.RETHINK_TASK}

          issue: ${JSON.stringify(issue)}
          task: ${JSON.stringify(this.todo.getTask(issue.parentTaskId))}
          spec: ${JSON.stringify(this.spec)}
        `);
      }
    }

    if (this.todo.hasBlocker()) {
      this.log.block(this.todo.explainBlocker()); // raise to human
    }
    this.snapshot();
  }

  private implement(): Promise<void> {
    return this.workspace.usesCloud() ? this.implementInCloud() : this.implementLocally();
  }

  // starts what is ready, every time a task ends looks for what it unlocked
  private async implementInCloud(): Promise<void> {
    const started = new Map<string, Promise<void>>();
    try {
      while (true) {
        for (const task of this.getReadyTasks()) {
          this.running.set(task.id, task);
          started.set(task.id, this.deliver(task).finally(() => {
            this.running.delete(task.id);
            started.delete(task.id);
          }));
        }
        this.snapshot();
        if (started.size === 0) return;
        await Promise.race(started.values());
      }
    } finally {
      await this.cancel();
    }
  }

  // not done, dependencies done, room left, and nobody else in its domain so they do not collide
  private getReadyTasks(): Task[] {
    const tasks = this.todo.getTasks();
    const taken = new Set([...this.running.values()].map((task) => task.domain));
    const ready: Task[] = [];

    for (const task of tasks) {
      if (this.running.size + ready.length >= this.workspace.getConcurrency()) break;
      if (task.isDone || this.running.has(task.id) || taken.has(task.domain)) continue;
      if (!task.dependsOn.every((id) => this.todo.getTask(id)?.isDone)) continue;
      ready.push(task);
      taken.add(task.domain);
    }
    return ready;
  }

  // implement, polish, code quality, performance and qa, all in the cloud.
  // Whatever gets rejected goes back to the same implementor. Only the result touches this machine
  private async deliver(task: Task): Promise<void> {
    const implementor = this.track(
      new CloudAgent(await this.rules.implementor(task.domain), this.log, this.workspace, {
        label: `implementor:${task.id}`,
        startingRef: this.workspace.getBranch() ?? "",
      }),
    );

    try {
      let attempts = 0;
      let reviewed: string | null = null;
      while (!task.isDone) {
        if (attempts++ >= MAX_ATTEMPTS) this.log.fail(`task ${task.id} did not converge`);

        const worked: string | null = await implementor.work("IMPLEMENT", `
          ${implementMessage(task)}
          scope: only change files under ${this.workspace.getRepoPath(task.domain)}, anything else gets rejected. do not open a pull request
          ${reviewed ? `the last version reviewed is on ${reviewed}, start with: git pull --ff-only origin ${reviewed}` : ""}
        `);
        if (!worked) {
          this.sendBack(task, null, "you did not push any change");
          continue;
        }

        const candidate = await this.polish(task, worked);
        reviewed = candidate;
        if (await this.passesReviews(task, candidate)) {
          await this.throughGate(() => this.integrate(task, candidate));
        }
      }
    } finally {
      this.release(implementor);
    }
  }

  // polishes on a branch of its own, so a rejection never leaves the implementor behind its remote
  private async polish(task: Task, branch: string): Promise<string> {
    const polished = await this.inCloud(await this.rules.polisher(task.domain), `polisher:${task.id}`, branch, {}, (agent) =>
      agent.work("POLISH", this.reviewMessage(task)),
    );
    return polished ?? branch;
  }

  // in order, each one with fresh eyes. The first rejection ends the round
  private async passesReviews(task: Task, branch: string): Promise<boolean> {
    const refused = await this.throughGate(async () => this.workspace.checkBranch(branch, task.domain));
    if (refused) {
      this.sendBack(task, branch, refused);
      return false;
    }

    task.qa = null;
    const reviews = [
      { name: "quality-reviewer", step: "REVIEW_QUALITY", role: await this.rules.qualityReviewer(task.domain) },
      { name: "performance-reviewer", step: "REVIEW_PERFORMANCE", role: await this.rules.performanceReviewer(task.domain) },
    ];
    for (const { name, step, role } of reviews) {
      task.review = await this.inCloud(role, `${name}:${task.id}`, branch, {}, (agent) => agent.judge(step, this.reviewMessage(task)));
      if (!task.review.approved) return false;
    }

    task.qa = await this.inCloud(this.rules.qa(task.intent, this.spec.acceptance), `qa:${task.id}`, branch, { mcp: true }, (agent) =>
      agent.judge("QA", `
        ${this.reviewMessage(task)}
        env detail: ${this.workspace.getEnvDetails()}
      `),
    );
    return task.qa.approved;
  }

  private async inCloud<T>(
    role: string,
    label: string,
    startingRef: string,
    options: { mcp?: boolean },
    use: (agent: CloudAgent) => Promise<T>,
  ): Promise<T> {
    const agent = this.track(new CloudAgent(role, this.log, this.workspace, { label, startingRef, ...options }));
    try {
      return await use(agent);
    } finally {
      this.release(agent);
    }
  }

  private track(agent: CloudAgent): CloudAgent {
    this.cloudAgents.add(agent);
    return agent;
  }

  private release(agent: CloudAgent): void {
    this.cloudAgents.delete(agent);
    agent.close();
  }

  private reviewMessage(task: Task): string {
    return `
      task: ${task.description}
      domain: ${task.domain}
      intent: ${JSON.stringify(task.intent)}
      the change: git diff origin/${this.workspace.getBranch()}...HEAD
    `;
  }

  // squashes the approved branch into the run branch
  private async integrate(task: Task, branch: string): Promise<void> {
    const refused = this.workspace.applyBranch(branch, task.domain);
    if (refused) {
      this.sendBack(task, branch, refused);
      return;
    }

    this.workspace.commit(commitMessage(task));
    const problem = this.workspace.pushRun(); // what depends on this task starts from there
    if (problem) this.log.fail(problem);
    this.todo.markDone(task.id);
  }

  private sendBack(task: Task, branch: string | null, reason: string): void {
    this.log.write("refused", { task: task.id, branch, reason });
    task.review = { approved: false, notes: reason };
    task.qa = null;
  }

  private throughGate<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.gate.then(work);
    this.gate = turn.catch(() => {});
    return turn;
  }

  private async judges(task: Task): Promise<{ reviewer: Agent; verifier: Agent }> {
    const label = (role: string): string => `${role}:${task.id}`;
    return {
      reviewer: new Agent(await this.rules.reviewer(task.domain), this.log, this.workspace, { label: label("reviewer") }),
      verifier: new Agent(this.rules.verifier(task.intent, this.spec.acceptance), this.log, this.workspace, {
        label: label("verifier"),
        access: { kind: "host" },
        mcp: true,
      }),
    };
  }

  private async implementLocally(): Promise<void> {
    for (const task of this.todo.getTasks().filter((task) => !task.isDone)) {
      const label = (role: string): string => `${role}:${task.id}`;
      const implementor = new Agent(await this.rules.implementor(task.domain), this.log, this.workspace, {
        label: label("implementor"),
        access: { kind: "domain", domain: task.domain },
      });
      const { reviewer, verifier } = await this.judges(task);

      let attempts = 0;
      while (!task.review?.approved || !task.qa?.approved) {
        if (attempts++ >= MAX_ATTEMPTS) this.log.fail(`task ${task.id} did not converge`);

        await implementor.prompt("IMPLEMENT", implementMessage(task));

        task.review = await reviewer.judge("REVIEW_TASK", `
          task: ${task.description}
          diff: ${this.workspace.getTaskDiff()}
        `);

        task.qa = await verifier.judge("VERIFY_TASK", `
          env detail: ${this.workspace.getEnvDetails()}
        `);
      }

      this.workspace.commit(commitMessage(task));
      this.todo.markDone(task.id);
      this.snapshot();
    }
  }

  // the local pass over the whole run: the user checks, the full review and the verifier on this machine.
  // returns true when they all pass,
  // otherwise sends the feedback back to the categorizer
  private async finalReview(): Promise<boolean> {
    const failures = this.workspace.runChecks();
    this.log.write("checks", { failures });

    const verdict = await this.finalReviewer.judge("REVIEW", `
      ${steps.REVIEW}

      spec: ${JSON.stringify(this.spec)}
      diff: ${this.workspace.getRunDiff()}
    `);

    const qa = await this.finalVerifier.judge("VERIFY_RUN", `
      env detail: ${this.workspace.getEnvDetails()}
    `);

    if (failures.length === 0 && verdict.approved && qa.approved) return true;

    await this.categorizer.prompt("RECATEGORIZE_FEEDBACK", `
      ${steps.RECATEGORIZE_FEEDBACK}

      failures: ${JSON.stringify(failures)}
      review: ${verdict.notes}
      qa: ${qa.notes}
      tasks: ${JSON.stringify(this.todo.getTasks())}
    `);
    this.snapshot();
    return false;
  }

  // the todo only lives in memory, this is what `plain status` reads
  private snapshot(): void {
    this.log.write("todo", {
      tasks: this.todo.getTasks().map((task) => ({
        id: task.id,
        domain: task.domain,
        title: title(task),
        isDone: task.isDone,
        isRunning: this.running.has(task.id),
      })),
    });
  }
}

function implementMessage(task: Task): string {
  return `
    task: ${task.description}
    domain: ${task.domain}
    intent: ${JSON.stringify(task.intent)}
    reviewer notes: ${task.review?.notes ?? ""}
    qa notes: ${task.qa?.notes ?? ""}
  `;
}

function title(task: Task): string {
  return task.description.split("\n")[0]?.slice(0, 72) ?? "";
}

function commitMessage(task: Task): string {
  return `plain: ${task.id} ${title(task)}\n\n${task.description}`;
}
