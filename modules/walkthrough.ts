import { existsSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { z } from "zod";

const image = z.string().describe("path of a screenshot, relative to the walkthrough dir. It gets embedded in the page");

const parts = {
  text: z.string().optional().describe("plain prose, a blank line starts a new paragraph. One or two sentences"),
  file: z.string().optional().describe("path of the file the code or diff is from"),
  code: z.string().optional().describe("a snippet, only the lines that matter"),
  diff: z.string().optional().describe("a unified diff, lines starting with + and -"),
  image: image.optional(),
  caption: z.string().optional(),
  before: image.optional().describe("the same view before the change, shown next to `after`"),
  after: image.optional(),
};

const DetailSchema = z.object({ label: z.string().describe("what the user clicks to see it, 1 to 4 words"), ...parts });

const StepSchema = z.object({
  kind: z.enum(["code", "locate", "diff", "ui", "note"]).describe(
    "code: how it is today. locate: screenshot with the element outlined in red. diff: the change. ui: how it looks after. note: anything else",
  ),
  title: z.string(),
  ...parts,
  more: z.array(DetailSchema).optional().describe("deeper detail, hidden until clicked: the why, the full diff, what a reviewer rejected, edge cases"),
});

const ChangeSchema = z.object({
  title: z.string().describe("what changed for the user, not the task id"),
  domain: z.string().optional(),
  why: z.string().describe("one or two sentences, the first thing shown when the change is opened"),
  steps: z.array(StepSchema).min(1).describe("shown one at a time, in the order that teaches it best"),
});

export const WalkthroughSchema = z.object({
  title: z.string(),
  summary: z.string().describe("the whole run in two sentences, all the user sees before clicking"),
  branch: z.string().optional(),
  pr: z.string().optional().describe("url of the draft pr"),
  labels: z.record(z.string(), z.string()).optional().describe(
    "the interface texts in the user's language. keys: changes, scenarios, next, nextChange, done, showAll, collapse, before, after, kind.code, kind.locate, kind.diff, kind.ui, kind.note",
  ),
  scenarios: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  changes: z.array(ChangeSchema).min(1).describe("ordered so each one builds on the previous"),
});

export type Walkthrough = z.infer<typeof WalkthroughSchema>;

export type Commit = {
  sha: string;
  taskId: string | null; // null when the commit is not from a task
  title: string;
  files: string[];
};

export type BuildResult = { ok: true; html: string } | { ok: false; errors: string[] };

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// what each kind of step can not go without
const REQUIRED: Record<z.infer<typeof StepSchema>["kind"], (step: z.infer<typeof StepSchema>) => string | null> = {
  code: (step) => (step.code ? null : "needs code"),
  locate: (step) => (step.image ? null : "needs image, the screenshot with the element outlined"),
  diff: (step) => (step.diff ? null : "needs diff"),
  ui: (step) => (step.image || (step.before && step.after) ? null : "needs image, or before and after"),
  note: (step) => (step.text ? null : "needs text"),
};

export function walkthroughJsonSchema(): unknown {
  return z.toJSONSchema(WalkthroughSchema);
}

// one self-contained page: the data and its screenshots go inside the template
export async function buildWalkthrough(raw: unknown, dir: string, template: string): Promise<BuildResult> {
  const parsed = WalkthroughSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const data = parsed.data;
  const errors: string[] = [];

  const embed = async (path: string, where: string): Promise<string> => {
    const file = resolve(dir, path);
    const mime = MIME[extname(file).toLowerCase()];
    if (relative(dir, file).startsWith("..")) errors.push(`${where}: ${path} is outside the walkthrough dir`);
    else if (!mime) errors.push(`${where}: ${path} is not a png, jpg, webp or gif`);
    else if (!existsSync(file)) errors.push(`${where}: ${path} does not exist, take the screenshot or drop the step`);
    else return `data:${mime};base64,${Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")}`;
    return path;
  };

  const embedAll = async (item: { image?: string; before?: string; after?: string }, where: string): Promise<void> => {
    for (const key of ["image", "before", "after"] as const) {
      const path = item[key];
      if (path) item[key] = await embed(path, `${where}.${key}`);
    }
  };

  for (const [c, change] of data.changes.entries()) {
    for (const [s, step] of change.steps.entries()) {
      const where = `changes.${c}.steps.${s}`;
      const missing = REQUIRED[step.kind](step);
      if (missing) errors.push(`${where}: a ${step.kind} step ${missing}`);
      await embedAll(step, where);
      for (const [m, detail] of (step.more ?? []).entries()) await embedAll(detail, `${where}.more.${m}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // "<" escaped so nothing in the data can close the script tag
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return { ok: true, html: template.split("__DATA__").join(json) };
}

// the commits of the run, oldest first, with the task each one closes
export function listCommits(cwd: string, base: string, branch: string): Commit[] {
  const log = Bun.spawnSync(["git", "log", "--reverse", "--name-only", "--format=%x00%H%x09%s", `${base}..${branch}`], { cwd });
  return log.stdout
    .toString()
    .split("\0")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [header = "", ...files] = entry.split("\n");
      const [sha = "", subject = ""] = header.split("\t");
      const task = subject.match(/^plain: (\S+) (.*)$/);
      return {
        sha,
        taskId: task?.[1] ?? null,
        title: task?.[2] ?? subject,
        files: files.filter((file) => file !== ""),
      };
    });
}
