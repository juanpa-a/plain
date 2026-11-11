import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { installSkill } from "../modules/install";
import { fixture } from "./fixture";

const source = (): Promise<string> => fixture({ "SKILL.md": "# plain" });

describe("installSkill", () => {
  test("one copy in ~/.agents, linked from the harnesses on the machine only", async () => {
    const home = await fixture({});
    mkdirSync(join(home, ".claude"));

    const result = installSkill(home, await source());

    expect(await Bun.file(join(home, ".agents/skills/plain/SKILL.md")).text()).toBe("# plain");
    expect(result.linked).toEqual([join(home, ".claude/skills/plain")]);
    expect(await Bun.file(join(home, ".claude/skills/plain/SKILL.md")).text()).toBe("# plain");
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  test("running it again updates the copy", async () => {
    const home = await fixture({});
    mkdirSync(join(home, ".cursor"));
    installSkill(home, await source());
    const result = installSkill(home, await fixture({ "SKILL.md": "# new" }));

    expect(result.skipped).toEqual([]);
    expect(await Bun.file(join(home, ".cursor/skills/plain/SKILL.md")).text()).toBe("# new");
    expect(readlinkSync(join(home, ".cursor/skills/plain"))).toBe("../../.agents/skills/plain");
  });

  test("does not touch a skill of the user with the same name", async () => {
    const home = await fixture({ ".claude/skills/plain/SKILL.md": "mine" });
    const result = installSkill(home, await source());

    expect(result.linked).toEqual([]);
    expect(result.skipped.map((item) => item.path)).toEqual([join(home, ".claude/skills/plain")]);
    expect(lstatSync(join(home, ".claude/skills/plain")).isSymbolicLink()).toBe(false);
    expect(await Bun.file(join(home, ".claude/skills/plain/SKILL.md")).text()).toBe("mine");
  });
});
