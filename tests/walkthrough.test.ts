import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildWalkthrough, listCommits } from "../modules/walkthrough";
import { fixture } from "./fixture";

const TEMPLATE = '<script id="data" type="application/json">__DATA__</script>';
const PNG = "\x89PNG fake";

const base = (steps: object[]): object => ({ title: "t", summary: "s", changes: [{ title: "c", why: "w", steps }] });

function embedded(html: string): any {
  return JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>")));
}

describe("buildWalkthrough", () => {
  test("embeds the screenshots so the page is one file", async () => {
    const dir = await fixture({ "shots/a.png": PNG });
    const result = await buildWalkthrough(
      base([{ kind: "locate", title: "here", image: "shots/a.png", more: [{ label: "zoom", image: "shots/a.png" }] }]),
      dir,
      TEMPLATE,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = embedded(result.html).changes[0].steps[0];
    expect(step.image).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(step.more[0].image).toStartWith("data:image/png;base64,");
  });

  test("nothing in the data can close the script tag", async () => {
    const code = 'const a = "</script><script>alert(1)</script>";';
    const result = await buildWalkthrough(base([{ kind: "code", title: "x", code }]), await fixture({}), TEMPLATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html.match(/<\/script>/g)).toHaveLength(1);
    expect(embedded(result.html).changes[0].steps[0].code).toBe(code);
  });

  test("a step without what its kind needs is an error", async () => {
    const result = await buildWalkthrough(
      base([
        { kind: "code", title: "a" },
        { kind: "locate", title: "b", text: "it is at the top" },
        { kind: "diff", title: "c" },
        { kind: "ui", title: "d", before: "shots/a.png" },
        { kind: "note", title: "e" },
      ]),
      await fixture({ "shots/a.png": PNG }),
      TEMPLATE,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        "changes.0.steps.0: a code step needs code",
        "changes.0.steps.1: a locate step needs image, the screenshot with the element outlined",
        "changes.0.steps.2: a diff step needs diff",
        "changes.0.steps.3: a ui step needs image, or before and after",
        "changes.0.steps.4: a note step needs text",
      ],
    });
  });

  test("a screenshot has to exist, be an image and live in the dir", async () => {
    const dir = await fixture({ "notes.txt": "x" });
    const result = await buildWalkthrough(
      base([
        { kind: "ui", title: "a", image: "shots/missing.png" },
        { kind: "ui", title: "b", image: "notes.txt" },
        { kind: "ui", title: "c", image: "../../etc/secret.png" },
      ]),
      dir,
      TEMPLATE,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        "changes.0.steps.0.image: shots/missing.png does not exist, take the screenshot or drop the step",
        "changes.0.steps.1.image: notes.txt is not a png, jpg, webp or gif",
        "changes.0.steps.2.image: ../../etc/secret.png is outside the walkthrough dir",
      ],
    });
  });

  test("data with the wrong shape says where", async () => {
    const result = await buildWalkthrough({ title: "t", summary: "s", changes: [] }, await fixture({}), TEMPLATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toStartWith("changes:");
  });
});

describe("listCommits", () => {
  test("the commits of the run, oldest first, with their task and files", async () => {
    const repo = await fixture({ "README.md": "hi\n" });
    const git = (command: string) => Bun.$`sh -c ${command}`.cwd(repo).quiet();
    await git("git init -q && git config user.email t@t && git config user.name t && git add . && git commit -q -m init");
    const start = (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim();
    await git("git checkout -q -b plain/1");
    await Bun.write(join(repo, "src/a/one.ts"), "1");
    await Bun.write(join(repo, "src/a/two.ts"), "2");
    await git("git add . && git commit -q -m 'plain: t1 add the hook' -m 'the long description'");
    await Bun.write(join(repo, "src/b/three.ts"), "3");
    await git("git add . && git commit -q -m 'fix by hand'");

    const commits = listCommits(repo, start, "plain/1");

    expect(commits.map(({ sha, ...rest }) => rest)).toEqual([
      { taskId: "t1", title: "add the hook", files: ["src/a/one.ts", "src/a/two.ts"] },
      { taskId: null, title: "fix by hand", files: ["src/b/three.ts"] },
    ]);
    expect(commits[0]?.sha).toHaveLength(40);
  });
});
