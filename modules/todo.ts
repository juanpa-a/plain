import { z } from "zod";

import { defineTool, ToolError, type Tool, type Verdict } from "./agent";
import type { Domain } from "./domain";
import type { Intent } from "./spec";

export type Task = {
  id: string;
  description: string;
  domain: Domain;
  for: string[]; // ids of the spec scenarios this task serves
  intent: Intent; // scenarios specific to this task, written when it is groomed
  isGroomed: boolean;
  isDone: boolean;
  review: Verdict | null;
  qa: Verdict | null;
};

export type Issue = {
  id: string;
  description: string;
  parentTaskId: string;
};

type Blocker = {
  reason: string;
  abstractions: string[];
};

// what the todo needs to know about the spec and the repo to validate what the agents add
type Rules = {
  isKnownDomain: (domain: Domain) => boolean;
  scenarioIds: Set<string>;
};

const ScenarioSchema = z.object({ id: z.string(), given: z.string(), when: z.string(), then: z.string() });

export class Todo {
  private tasks: Task[] = [];
  private issues: Issue[] = [];
  private blockers: Blocker[] = [];

  constructor(private rules: Rules) {}

  public addTask(task: Pick<Task, "id" | "description" | "domain" | "for">): void {
    if (this.getTask(task.id)) throw new ToolError(`a task with id ${task.id} already exists`);
    if (!this.rules.isKnownDomain(task.domain)) {
      throw new ToolError(`domain ${task.domain} does not exist and is not a module in the spec`);
    }
    const unknown = task.for.filter((id) => !this.rules.scenarioIds.has(id));
    if (unknown.length > 0) throw new ToolError(`unknown scenarios in for: ${unknown.join(", ")}`);

    this.tasks.push({ ...task, intent: [], isGroomed: false, isDone: false, review: null, qa: null });
  }

  public getTask(id: string): Task | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  public getTasks(): Task[] {
    return this.tasks;
  }

  // writes the task specific intent and marks it as groomed
  public refineTask(id: string, description: string, intent: Intent): void {
    const task = this.requireTask(id);
    task.description = description;
    task.intent = intent;
    task.isGroomed = true;
  }

  public markDone(id: string): void {
    this.requireTask(id).isDone = true;
  }

  // sends a done task back to the implementation loop
  public reopenTask(id: string, notes: string): void {
    const task = this.requireTask(id);
    task.isDone = false;
    task.review = { approved: false, notes };
    task.qa = null;
  }

  public addIssue(issue: Issue): void {
    if (this.issues.some((item) => item.id === issue.id)) throw new ToolError(`an issue with id ${issue.id} already exists`);
    this.requireTask(issue.parentTaskId);
    this.issues.push(issue);
  }

  public getIssues(): Issue[] {
    return this.issues;
  }

  public resolveIssue(id: string): void {
    if (!this.issues.some((issue) => issue.id === id)) throw new ToolError(`there is no issue with id ${id}`);
    this.issues = this.issues.filter((issue) => issue.id !== id);
  }

  public addBlocker(reason: string, abstractions: string[]): void {
    this.blockers.push({ reason, abstractions });
  }

  public hasBlocker(): boolean {
    return this.blockers.length > 0;
  }

  public explainBlocker(): string {
    return this.blockers
      .map((blocker) => `${blocker.reason} (${blocker.abstractions.join(", ")})`)
      .join("\n");
  }

  public isFullyGroomed(): boolean {
    return this.issues.length === 0 && this.tasks.every((task) => task.isGroomed);
  }

  // what the agents can call to change the todo
  public getTools(): Tool[] {
    return [
      defineTool({
        name: "addTask",
        description: "add a task: one atomic change contained in one domain (directory)",
        input: z.object({ id: z.string(), description: z.string(), domain: z.string(), for: z.array(z.string()).min(1) }),
        run: (input) => this.addTask(input),
      }),
      defineTool({
        name: "refineTask",
        description: "write the final description and the scenarios specific to this task, marks it as groomed",
        input: z.object({ id: z.string(), description: z.string(), intent: z.array(ScenarioSchema).min(1) }),
        run: (input) => this.refineTask(input.id, input.description, input.intent),
      }),
      defineTool({
        name: "reopenTask",
        description: "send a done task back to be fixed",
        input: z.object({ id: z.string(), notes: z.string() }),
        run: (input) => this.reopenTask(input.id, input.notes),
      }),
      defineTool({
        name: "addIssue",
        description: "raise a plan time issue another agent pass should solve",
        input: z.object({ id: z.string(), description: z.string(), parentTaskId: z.string() }),
        run: (input) => this.addIssue(input),
      }),
      defineTool({
        name: "resolveIssue",
        description: "mark an issue as solved",
        input: z.object({ id: z.string() }),
        run: (input) => this.resolveIssue(input.id),
      }),
      defineTool({
        name: "addBlocker",
        description: "raise to the human when the abstractions can not express the feature",
        input: z.object({ reason: z.string(), abstractions: z.array(z.string()) }),
        run: (input) => this.addBlocker(input.reason, input.abstractions),
      }),
    ];
  }

  private requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new ToolError(`there is no task with id ${id}`);
    return task;
  }
}
