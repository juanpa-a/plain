import { expect, test } from "bun:test";
import { join } from "node:path";

import { readOnlyFs, unionFs } from "@cursor/sdk";

import { diskFs } from "../modules/disk-fs";
import { fixture } from "./fixture";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

test("reads, lists, globs and greps the directory", async () => {
  const fs = diskFs(await fixture({ "src/a.ts": "export const a = 1;\n", "src/nested/b.ts": "export const b = 2;\n" }));

  expect(await fs.read("/src/a.ts")).toBe("export const a = 1;\n");
  expect((await collect(fs.list("/"))).map((entry) => entry.path)).toEqual(["/src/a.ts", "/src/nested/b.ts"]);
  expect((await collect(fs.glob("*.ts", "/src"))).map((entry) => entry.path)).toEqual(["/src/a.ts"]);
  expect(await collect(fs.grep({ pattern: "const b" }))).toEqual([
    { path: "/src/nested/b.ts", lineNumber: 1, line: "export const b = 2;" },
  ]);
  expect(await fs.stat("/src")).toEqual({ kind: "directory" });
  expect(await fs.stat("/nope")).toEqual({ kind: "missing" });
});

test("can not escape its root", async () => {
  const fs = diskFs(await fixture({ "a.txt": "a" }));
  await expect(fs.read("/../../etc/passwd")).rejects.toThrow();
});

test("the implementor mount: only its domain is writable", async () => {
  const service = await fixture({ "src/lib/pdf/merge.ts": "", "src/other/x.ts": "" });
  const fs = unionFs({
    "/": readOnlyFs(diskFs(service)),
    "/src/lib/pdf": diskFs(join(service, "src/lib/pdf")),
  });

  await fs.write("/src/lib/pdf/new.ts", "export {};\n");
  expect(await Bun.file(join(service, "src/lib/pdf/new.ts")).text()).toBe("export {};\n");
  await expect(fs.write("/src/other/x.ts", "hacked")).rejects.toThrow();
  expect(await fs.read("/src/other/x.ts")).toBe("");
});
