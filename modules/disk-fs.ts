import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { FileNotFoundError, InvalidGrepPatternError, type FileSystem } from "@cursor/sdk";

// directories the agents never need to see
const IGNORED: string[] = ["node_modules", ".git"];

const IMAGES: string[] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

type Entry = { path: string; size?: number; kind?: "file" | "directory" };

// a cursor sdk FileSystem backed by a directory on disk, paths are absolute posix inside `root` (`/src/a.ts`)
export function diskFs(root: string): FileSystem {
  const base = resolve(root);

  function toDisk(path: string): string {
    const full = resolve(join(base, path));
    if (full !== base && !full.startsWith(`${base}/`)) throw new FileNotFoundError(path);
    return full;
  }

  function toTree(full: string): string {
    return `/${relative(base, full)}`;
  }

  function kindOf(full: string): "file" | "directory" | "missing" {
    try {
      return statSync(full).isDirectory() ? "directory" : "file";
    } catch {
      return "missing";
    }
  }

  function* files(dir: string, pattern: string = "**/*"): Generator<string> {
    if (kindOf(dir) !== "directory") return;
    const scanned = [...new Bun.Glob(pattern).scanSync({ cwd: dir, dot: true, onlyFiles: true })]
      .filter((file) => !file.split("/").some((part) => IGNORED.includes(part)))
      .sort();
    for (const file of scanned) yield join(dir, file);
  }

  return {
    async *list(prefix = "/", options = {}) {
      const dir = toDisk(prefix);
      const seen = new Set<string>();
      let count = 0;

      for (const full of files(dir)) {
        if (options.limit !== undefined && count >= options.limit) return;
        const parts = relative(dir, full).split("/");
        const excluded = options.excludes?.some((exclude) => toTree(full).startsWith(exclude));
        if (excluded) continue;

        // cut the subtree off at maxDepth and report it as a directory
        let entry: Entry = { path: toTree(full), kind: "file", size: statSync(full).size };
        if (options.maxDepth !== undefined && parts.length > options.maxDepth) {
          entry = { path: toTree(join(dir, ...parts.slice(0, options.maxDepth))), kind: "directory" };
        }
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        count++;
        yield entry;
      }
    },

    async stat(path) {
      return { kind: kindOf(toDisk(path)) };
    },

    async *glob(pattern, dir = "/", options = {}) {
      let count = 0;
      for (const full of files(toDisk(dir), pattern)) {
        if (options.limit !== undefined && count++ >= options.limit) return;
        yield { path: toTree(full), kind: "file", size: statSync(full).size };
      }
    },

    async read(path) {
      const full = toDisk(path);
      if (kindOf(full) !== "file") throw new FileNotFoundError(path);
      const file = Bun.file(full);
      return IMAGES.some((extension) => full.endsWith(extension)) ? new Uint8Array(await file.arrayBuffer()) : file.text();
    },

    async *grep(query) {
      let regex: RegExp;
      try {
        regex = new RegExp(query.pattern, query.caseInsensitive ? "i" : "");
      } catch {
        throw new InvalidGrepPatternError(query.pattern, query.path);
      }

      const target = toDisk(query.path || "/");
      const candidates = kindOf(target) === "file" ? [target] : [...files(target, query.glob ?? "**/*")];
      let count = 0;

      for (const full of candidates) {
        if (query.excludes?.some((exclude) => toTree(full).startsWith(exclude))) continue;
        const lines = (await Bun.file(full).text()).split("\n");
        for (const [index, line] of lines.entries()) {
          if (!regex.test(line)) continue;
          if (query.maxResults !== undefined && count++ >= query.maxResults) return;
          yield { path: toTree(full), lineNumber: index + 1, line };
        }
      }
    },

    async write(path, contents) {
      const full = toDisk(path);
      mkdirSync(dirname(full), { recursive: true });
      await Bun.write(full, contents);
    },

    async delete(path) {
      const full = toDisk(path);
      if (kindOf(full) !== "file") throw new FileNotFoundError(path);
      unlinkSync(full);
    },
  };
}
