import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Workspace } from "../modules/workspace";
import { fixture } from "./fixture";

async function gitService(): Promise<string> {
  const dir = await fixture({ "README.md": "hi\n" });
  await Bun.$`git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git add . && git -c user.email=t@t -c user.name=t commit -q -m readme`.cwd(dir);
  return dir;
}

async function workspace(service: string, config: object = {}): Promise<Workspace> {
  const dir = await fixture({ "config.json": JSON.stringify(config) });
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

describe("git", () => {
  test("refuses to start on a dirty tree", async () => {
    const service = await gitService();
    await Bun.write(join(service, "dirty.txt"), "x");
    expect((await workspace(service)).startRun()).toBe("the working tree has uncommitted changes");
  });

  test("the task diff is what changed since the last commit, the run diff everything since the start", async () => {
    const service = await gitService();
    const ws = await workspace(service);
    expect(ws.startRun()).toBeNull();

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
