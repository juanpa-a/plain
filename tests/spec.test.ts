import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { SpecError, Specs, type Spec } from "../modules/spec";
import { fixture, SERVICE } from "./fixture";

const specs = new Specs();

async function errorsOf(spec: Spec, service: string): Promise<string[]> {
  try {
    await specs.verify(spec, { root: service, service });
    return [];
  } catch (error) {
    if (error instanceof SpecError) return error.errors;
    throw error;
  }
}

describe("load", () => {
  test("parses and validates the example spec", async () => {
    const spec = await specs.load(join(import.meta.dir, "../spec.example.yaml"));
    expect(spec.feature).toBe("Download invoice as PDF");
    expect(spec.modules).toHaveLength(3);
  });

  test("invalid yaml is a SpecError", async () => {
    const dir = await fixture({ "spec.yaml": "signature: (a: string) => void" });
    await expect(specs.load(join(dir, "spec.yaml"))).rejects.toBeInstanceOf(SpecError);
  });

  test("a wrong shape is a SpecError with the path of the problem", async () => {
    const dir = await fixture({
      "spec.yaml": "feature: x\nintent: []\nacceptance: []\ntypes: []\nmodules:\n  - path: a\n    changes:\n      - add: foo\n",
    });
    const error = await specs.load(join(dir, "spec.yaml")).catch((error) => error);
    expect(error).toBeInstanceOf(SpecError);
    expect(error.errors[0]).toStartWith("modules.0.changes.0:");
  });
});

describe("verify", () => {
  test("the example spec passes against a matching service", async () => {
    const service = await fixture(SERVICE);
    const spec = await specs.load(join(import.meta.dir, "../spec.example.yaml"));
    expect(await errorsOf(spec, service)).toEqual([]);
  });

  test("reports every problem at once", async () => {
    const service = await fixture({ ...SERVICE, "src/gateways/crm/AGENTS.md": "" });
    await Bun.$`rm ${join(service, "src/gateways/crm/AGENTS.md")}`;

    const spec: Spec = {
      feature: "edge",
      intent: [{ id: "s", given: "g", when: "w", then: "t" }],
      acceptance: [],
      types: [
        { name: "User", from: "@acme/missing" },
        { name: "Customer", from: "src/gateways/crm", expects: { id: "string", phone: "string" } },
      ],
      modules: [
        { path: "src/gateways/billing", changes: [{ add: "useLegacyInvoiceLink", signature: "() => void", for: ["s"] }] },
        { path: "src/brand-new", changes: [{ modify: "something", notes: "n", for: ["s"] }] },
        { path: "src/gateways/crm", changes: [] },
        { path: "src/lib/pdf", changes: [{ remove: "mergePdfs" }] },
        { path: "src/features/invoice-list", changes: [{ modify: "InvoiceList.Cell", notes: "n", for: ["ghost"] }] },
      ],
    };

    const errors = await errorsOf(spec, service);
    expect(errors).toContain("src/gateways/crm: the module exists but has no AGENTS.md");
    expect(errors).toContain("src/brand-new: modify something, a new module can only add");
    expect(errors).toContain("src/gateways/billing: add useLegacyInvoiceLink, it already exists");
    // mergePdfs lives in a submodule with its own AGENTS.md
    expect(errors).toContain("src/lib/pdf: remove mergePdfs, mergePdfs is not exported from the module");
    expect(errors).toContain("src/features/invoice-list: modify InvoiceList.Cell, InvoiceList has no member Cell");
    expect(errors).toContain("src/features/invoice-list: for ghost, which is not a scenario in intent");
    expect(errors).toContain("type User: from @acme/missing, which is not a path or an installed package");
    expect(errors.some((error) => error.startsWith("type Customer: does not satisfy expects"))).toBe(true);
  });

  test("expects passes when the type has at least that shape", async () => {
    const service = await fixture(SERVICE);
    const spec: Spec = {
      feature: "shape",
      intent: [],
      acceptance: [],
      types: [{ name: "Customer", from: "src/gateways/crm", expects: { id: "string", "name?": "string" } }],
      modules: [],
    };
    expect(await errorsOf(spec, service)).toEqual([]);
  });

  test("a defined type can not exist yet", async () => {
    const service = await fixture(SERVICE);
    const spec: Spec = {
      feature: "collision",
      intent: [],
      acceptance: [],
      types: [{ name: "Customer", at: "src/gateways/crm", shape: { id: "string" } }],
      modules: [],
    };
    expect(await errorsOf(spec, service)).toEqual(["type Customer: at src/gateways/crm, it already exists"]);
  });
});
