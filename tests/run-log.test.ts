import { expect, test } from "bun:test";
import { join } from "node:path";

import { RunFailed, RunLog } from "../modules/run-log";
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
