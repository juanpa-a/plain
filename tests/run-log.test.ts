import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readRunReport, RunBlocked, RunFailed, RunLog } from "../modules/run-log";
import { fixture } from "./fixture";

test("writes one json event per line, from start to finish", async () => {
  const log = new RunLog(join(await fixture({}), "run"));
  log.start({ spec: "spec.yaml" });
  expect(() => log.fail("task t1 did not converge")).toThrow(RunFailed);
  log.finish("fail", { tasks: 1 });

  const events = (await Bun.file(log.getPath()).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => event.step)).toEqual(["start", "fail", "finish"]);
  expect(events[2].data).toEqual({ status: "fail", tasks: 1 });
});

test("a blocked run throws something the entry point can tell apart", async () => {
  const log = new RunLog(join(await fixture({}), "run"));
  expect(() => log.block("needs a human")).toThrow(RunBlocked);
});

describe("report", () => {
  const newLog = async (): Promise<RunLog> => new RunLog(join(await fixture({}), "run"));

  test("a run that does not exist has no report", async () => {
    expect(await readRunReport("nope", join(await fixture({}), "run"))).toBeNull();
  });

  test("while it runs: where it is, the latest todo and the rejections", async () => {
    const log = await newLog();
    log.start({ spec: "a.yaml", pid: process.pid });
    log.write("workspace", { branch: "plain/1", worktree: "/w", base: "abc" });
    log.write("todo", { tasks: [{ id: "t1", domain: "a", title: "old", isDone: false }] });
    log.write("todo", { tasks: [{ id: "t1", domain: "a", title: "new", isDone: true, isRunning: false }] });
    log.write("verdict", { agent: "reviewer:t1", step: "REVIEW_TASK", approved: false, notes: "no tests" });
    log.write("verdict", { agent: "reviewer:t1", step: "REVIEW_TASK", approved: true, notes: "good" });
    log.write("prompt", { agent: "implementor:t2", step: "IMPLEMENT" });

    expect(await readRunReport("1", log.getDir())).toEqual({
      id: "1",
      status: "running",
      pid: process.pid,
      spec: "a.yaml",
      branch: "plain/1",
      base: "abc",
      worktree: "/w",
      pr: null,
      prError: null,
      current: "implementor:t2 IMPLEMENT",
      tasks: [{ id: "t1", domain: "a", title: "new", isDone: true, isRunning: false }],
      rejections: [{ agent: "reviewer:t1", step: "REVIEW_TASK", notes: "no tests" }],
      message: null,
      log: log.getPath(),
    });
  });

  test("a finished run reports how it ended and whether the worktree is still there", async () => {
    const log = await newLog();
    log.start({ spec: "a.yaml", pid: process.pid });
    log.write("workspace", { branch: "plain/1", worktree: "/w" });
    log.finish("blocked", { message: "needs a human", worktree: "/w" });
    expect(await readRunReport("1", log.getDir())).toMatchObject({ status: "blocked", message: "needs a human", worktree: "/w" });

    const success = await newLog();
    success.start({ spec: "a.yaml", pid: process.pid });
    success.write("workspace", { branch: "plain/1", worktree: "/w" });
    success.finish("success", { message: "done", worktree: null, pr: "https://x/pull/1", prError: null });
    expect(await readRunReport("1", success.getDir())).toMatchObject({ status: "success", worktree: null, branch: "plain/1", pr: "https://x/pull/1" });
  });

  test("no finish and the process is gone means it crashed", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const log = await newLog();
    log.write("detached", { pid: dead.pid });
    expect((await readRunReport("1", log.getDir()))?.status).toBe("crashed");
  });
});
