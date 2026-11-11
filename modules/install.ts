import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export type InstallResult = {
  installedAt: string;
  linked: string[];
  skipped: { path: string; reason: string }[];
};

const SHARED_DIR = ".agents/skills/plain";
const LINK_TARGET = "../../.agents/skills/plain";
const HARNESSES = [".claude", ".cursor"]; // codex has no skills dir yet

// one real copy in ~/.agents/skills, each harness on this machine links to it
export function installSkill(home: string, source: string): InstallResult {
  const installedAt = join(home, SHARED_DIR);
  rmSync(installedAt, { recursive: true, force: true });
  mkdirSync(dirname(installedAt), { recursive: true });
  cpSync(source, installedAt, { recursive: true });

  const result: InstallResult = { installedAt, linked: [], skipped: [] };
  for (const harness of HARNESSES) {
    if (!existsSync(join(home, harness))) continue;

    const path = join(home, harness, "skills", "plain");
    if (isOtherFile(path)) {
      result.skipped.push({ path, reason: "something else is already there" });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    symlinkSync(LINK_TARGET, path);
    result.linked.push(path);
  }
  return result;
}

function isOtherFile(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== LINK_TARGET;
  } catch {
    return false; // nothing there
  }
}
