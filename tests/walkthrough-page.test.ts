import { describe, expect, test } from "bun:test";

import { buildWalkthrough } from "../modules/walkthrough";
import { fixture } from "./fixture";

// just enough of the DOM to run the page's script and click through it
class FakeNode {
  public children: FakeNode[] = [];
  public className = "";
  public hidden = false;
  public disabled = false;
  public type = "";
  public src = "";
  public alt = "";
  public href = "";
  public attributes: Record<string, string> = {};
  private text = "";
  private listeners: (() => void)[] = [];

  constructor(public tag: string) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  public appendChild(node: FakeNode): FakeNode {
    if (node.tag === "#fragment") this.children.push(...node.children);
    else this.children.push(node);
    return node;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public addEventListener(_event: string, listener: () => void): void {
    this.listeners.push(listener);
  }

  public click(): void {
    if (!this.disabled) this.listeners.forEach((listener) => listener());
  }

  public scrollIntoView(): void {}

  // only ".class" selectors, all the page uses
  public querySelectorAll(selector: string): FakeNode[] {
    const name = selector.slice(1);
    return this.children.flatMap((child) => [
      ...(child.className.split(" ").includes(name) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const DATA = {
  title: "Descargar factura",
  summary: "Cada fila tiene un botón de descarga.",
  branch: "plain/1",
  pr: "https://github.com/acme/app/pull/12",
  labels: { next: "Siguiente paso", nextChange: "Siguiente cambio", done: "Eso es todo", showAll: "Mostrar todo", collapse: "Colapsar", "kind.locate": "Dónde está" },
  scenarios: [{ id: "s1", text: "se descarga" }],
  changes: [
    {
      title: "Botón en la fila",
      why: "La fila no tenía acciones.",
      steps: [
        { kind: "code", title: "La fila hoy", code: "<tr></tr>" },
        { kind: "locate", title: "Es esta", image: "shots/a.png" },
        { kind: "diff", title: "Nueva celda", diff: "@@ -1,2 +1,3 @@\n <tr>\n-  <td/>\n+  <td>a</td>\n+  <td>b</td>\n", more: [{ label: "Por qué", text: "uno\n\ndos" }] },
        { kind: "ui", title: "Así queda", before: "shots/a.png", after: "shots/a.png" },
      ],
    },
    { title: "Hook", why: "Para pedir el PDF.", steps: [{ kind: "note", title: "Sin interfaz", text: "No se ve." }] },
  ],
};

async function open(data: object): Promise<FakeNode> {
  const template = await Bun.file(new URL("../templates/walkthrough.html", import.meta.url)).text();
  const built = await buildWalkthrough(data, await fixture({ "shots/a.png": "png" }), template);
  if (!built.ok) throw new Error(built.errors.join("\n"));

  const scripts = [...built.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  const [json = "", code = ""] = scripts;
  const app = new FakeNode("main");
  const holder = new FakeNode("script");
  holder.textContent = json;
  const document = {
    title: "",
    getElementById: (id: string) => (id === "data" ? holder : app),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
    createDocumentFragment: () => new FakeNode("#fragment"),
  };
  new Function("document", code)(document);
  return app;
}

const all = (app: FakeNode, selector: string): FakeNode[] => app.querySelectorAll(selector);
const visibleBodies = (app: FakeNode): boolean[] => all(app, ".body").map((body) => !body.hidden);

describe("the walkthrough page", () => {
  test("starts with the summary and every change closed", async () => {
    const app = await open(DATA);
    expect(app.textContent).toContain("Cada fila tiene un botón de descarga.");
    expect(all(app, ".card")).toHaveLength(2);
    expect(visibleBodies(app)).toEqual([false, false]);
    expect(all(app, ".step")).toHaveLength(0);
  });

  test("opening a change shows its first step, each click adds one more", async () => {
    const app = await open(DATA);
    const next = all(app, ".primary")[0]!;

    all(app, ".head")[0]!.click();
    expect(visibleBodies(app)).toEqual([true, false]);
    expect(all(app, ".step")).toHaveLength(1);
    expect(next.textContent).toBe("Siguiente paso (2/4)");

    next.click();
    expect(all(app, ".step")).toHaveLength(2);
    expect(all(app, ".kind").map((kind) => kind.textContent)).toEqual(["The code today", "Dónde está"]); // labels fall back one by one
    expect(all(app, ".located")).toHaveLength(1);

    next.click();
    next.click();
    expect(all(app, ".step")).toHaveLength(4);
    expect(all(app, ".on")).toHaveLength(4);
    expect(next.textContent).toBe("Siguiente cambio →");
  });

  test("the diff marks what was added and removed", async () => {
    const app = await open(DATA);
    all(app, ".head")[0]!.click();
    all(app, ".primary")[0]!.click();
    all(app, ".primary")[0]!.click();
    expect(all(app, ".add").map((line) => line.textContent)).toEqual(["+  <td>a</td>", "+  <td>b</td>"]);
    expect(all(app, ".del")).toHaveLength(1);
    expect(all(app, ".hunk")).toHaveLength(1);
  });

  test("deeper detail stays hidden until its chip is clicked", async () => {
    const app = await open(DATA);
    all(app, ".head")[0]!.click();
    all(app, ".primary")[0]!.click();
    all(app, ".primary")[0]!.click();
    const card = all(app, ".card")[0]!;
    const [chip] = card.querySelectorAll(".chip");
    const [detail] = card.querySelectorAll(".detail");

    expect(detail?.hidden).toBe(true);
    chip!.click();
    expect(detail?.hidden).toBe(false);
    expect(chip?.attributes["aria-expanded"]).toBe("true");
    expect(detail?.children.map((child) => child.textContent)).toEqual(["uno", "dos"]);
    chip!.click();
    expect(detail?.hidden).toBe(true);
  });

  test("the last step leads into the next change, and the last change ends", async () => {
    const app = await open(DATA);
    const [first, second] = all(app, ".primary") as [FakeNode, FakeNode];
    all(app, ".head")[0]!.click();
    for (let click = 0; click < 4; click++) first.click();

    expect(visibleBodies(app)).toEqual([true, true]);
    expect(all(app, ".card")[1]!.querySelectorAll(".step")).toHaveLength(1);
    expect(second.textContent).toBe("Eso es todo");
    expect(second.disabled).toBe(true);
  });

  test("show everything opens every step and detail, and collapses back", async () => {
    const app = await open(DATA);
    const toggle = all(app, ".ghost")[0]!;

    toggle.click();
    expect(all(app, ".step")).toHaveLength(5);
    expect(all(app, ".card").flatMap((card) => card.querySelectorAll(".detail")).every((detail) => !detail.hidden)).toBe(true);
    expect(toggle.textContent).toBe("Colapsar");

    toggle.click();
    expect(visibleBodies(app)).toEqual([false, false]);
    expect(all(app, ".step")).toHaveLength(5); // reopening keeps what was already revealed
  });

  test("only an https pr becomes a link", async () => {
    const link = (app: FakeNode): string[] => all(app, ".meta").flatMap((meta) => meta.children).map((child) => child.href).filter(Boolean);
    expect(link(await open(DATA))).toEqual(["https://github.com/acme/app/pull/12"]);
    expect(link(await open({ ...DATA, pr: "javascript:alert(1)" }))).toEqual([]);
  });
});
