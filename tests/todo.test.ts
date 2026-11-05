import { describe, expect, test } from "bun:test";

import { ToolError } from "../modules/agent";
import { Todo } from "../modules/todo";

function todo(): Todo {
  return new Todo({
    isKnownDomain: (domain) => domain === "src/lib/pdf",
    scenarioIds: new Set(["download-invoice"]),
  });
}

const task = { id: "t1", description: "add mergePdfs", domain: "src/lib/pdf", for: ["download-invoice"] };

describe("tasks", () => {
  test("a new task starts not groomed and not done", () => {
    const list = todo();
    list.addTask(task);
    expect(list.getTask("t1")).toMatchObject({ isGroomed: false, isDone: false, intent: [] });
    expect(list.isFullyGroomed()).toBe(false);
  });

  test("rejects duplicated ids, unknown domains and unknown scenarios", () => {
    const list = todo();
    list.addTask(task);
    expect(() => list.addTask(task)).toThrow(ToolError);
    expect(() => list.addTask({ ...task, id: "t2", domain: "src/nope" })).toThrow(ToolError);
    expect(() => list.addTask({ ...task, id: "t3", for: ["ghost"] })).toThrow(ToolError);
  });

  test("refining writes the task intent and grooms it", () => {
    const list = todo();
    list.addTask(task);
    list.refineTask("t1", "merge the pdfs", [{ id: "merge", given: "two pdfs", when: "merged", then: "one pdf" }]);
    expect(list.getTask("t1")).toMatchObject({ isGroomed: true, description: "merge the pdfs" });
    expect(list.isFullyGroomed()).toBe(true);
  });

  test("reopening sends a done task back with the notes", () => {
    const list = todo();
    list.addTask(task);
    list.markDone("t1");
    list.reopenTask("t1", "the button has no loading state");
    expect(list.getTask("t1")).toMatchObject({ isDone: false, review: { approved: false, notes: "the button has no loading state" } });
  });
});

describe("issues and blockers", () => {
  test("an issue needs an existing parent task and blocks grooming until resolved", () => {
    const list = todo();
    expect(() => list.addIssue({ id: "i1", description: "x", parentTaskId: "t1" })).toThrow(ToolError);

    list.addTask(task);
    list.refineTask("t1", "d", [{ id: "s", given: "g", when: "w", then: "t" }]);
    list.addIssue({ id: "i1", description: "x", parentTaskId: "t1" });
    expect(list.isFullyGroomed()).toBe(false);

    list.resolveIssue("i1");
    expect(list.isFullyGroomed()).toBe(true);
    expect(() => list.resolveIssue("i1")).toThrow(ToolError);
  });

  test("blockers are explained", () => {
    const list = todo();
    list.addBlocker("no way to stream blobs", ["Mutation", "Blob"]);
    expect(list.hasBlocker()).toBe(true);
    expect(list.explainBlocker()).toBe("no way to stream blobs (Mutation, Blob)");
  });
});

describe("tools", () => {
  test("validate their input before touching the todo", () => {
    const list = todo();
    const addTask = list.getTools().find((tool) => tool.name === "addTask")!;
    expect(() => addTask.run({ id: "t1" })).toThrow(ToolError);
    expect(list.getTasks()).toHaveLength(0);

    addTask.run(task);
    expect(list.getTasks()).toHaveLength(1);
  });

  test("expose a JSON schema", () => {
    const refineTask = todo().getTools().find((tool) => tool.name === "refineTask")!;
    expect(refineTask.inputSchema).toMatchObject({ type: "object", required: ["id", "description", "intent"] });
  });
});
