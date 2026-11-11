import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript-api";
import { z } from "zod";

const ScenarioSchema = z.object({
  id: z.string(),
  given: z.string(),
  when: z.string(),
  then: z.string(),
});

const ShapeSchema = z.record(z.string(), z.string());

const TypeDefSchema = z.union([
  // define: created here
  z.object({ name: z.string(), at: z.string(), shape: ShapeSchema }),
  // reference, optionally with an expected shape
  z.object({ name: z.string(), from: z.string(), expects: ShapeSchema.optional() }),
], { error: "a type needs name and either at + shape (define) or from (reference)" });

const ChangeSchema = z.union([
  z.object({ add: z.string(), signature: z.string(), endpoint: z.string().optional(), for: z.array(z.string()) }),
  z.object({ modify: z.string(), notes: z.string(), for: z.array(z.string()) }),
  z.object({ remove: z.string() }),
], { error: "a change must be add (with signature and for), modify (with notes and for) or remove" });

const ModuleSchema = z.object({
  path: z.string(),
  dependencies: z.array(z.string()).optional(),
  uses: z.array(z.string()).optional(),
  changes: z.array(ChangeSchema),
});

const SpecSchema = z.object({
  feature: z.string(),
  intent: z.array(ScenarioSchema),
  acceptance: z.array(z.string()),
  types: z.array(TypeDefSchema),
  modules: z.array(ModuleSchema),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Intent = Scenario[];
export type Spec = z.infer<typeof SpecSchema>;


// root: the whole repo, service: where the spec paths are resolved (same as root outside monorepos)
export type Repo = {
  root: string;
  service: string;
};

export class SpecError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("\n"));
  }
}

// each check returns the errors it found, empty = ok
type Check = (spec: Spec, repo: Repo) => string[];

const CHECKS: Check[] = [modulesExist, methodsExist, noCollisions, typesResolve, shapesSatisfied, scenariosLinked];

// the shape of a spec as json schema, what `plain schema` prints
export function specJsonSchema(): unknown {
  return z.toJSONSchema(SpecSchema);
}

export class Specs {
  public async load(path: string): Promise<Spec> {
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(await Bun.file(path).text());
    } catch (error) {
      throw new SpecError([`${path}: invalid YAML, ${(error as Error).message}`]);
    }

    const result = SpecSchema.safeParse(raw);
    if (!result.success) {
      throw new SpecError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    }
    return result.data;
  }

  public async verify(spec: Spec, repo: Repo): Promise<void> {
    const errors = CHECKS.flatMap((check) => check(spec, repo));
    if (errors.length > 0) throw new SpecError(errors);
  }
}

// existing path → has AGENTS.md, missing path → new module, uses → exists or is in the spec
function modulesExist(spec: Spec, repo: Repo): string[] {
  const errors: string[] = [];
  const inSpec = new Set(spec.modules.map((module) => module.path));

  for (const module of spec.modules) {
    const path = join(repo.service, module.path);
    if (isDirectory(path) && !existsSync(join(path, "AGENTS.md"))) {
      errors.push(`${module.path}: the module exists but has no AGENTS.md`);
    }

    for (const use of module.uses ?? []) {
      if (!isDirectory(join(repo.service, use)) && !inSpec.has(use)) {
        errors.push(`${module.path}: uses ${use}, which does not exist and is not in the spec`);
      }
    }
  }
  return errors;
}

// modify/remove: the symbol has to exist, a new module can only add
function methodsExist(spec: Spec, repo: Repo): string[] {
  const errors: string[] = [];
  for (const module of spec.modules) {
    const isNew = !isDirectory(join(repo.service, module.path));

    for (const change of module.changes) {
      const name = "modify" in change ? change.modify : "remove" in change ? change.remove : null;
      if (name === null) continue;

      const verb = "modify" in change ? "modify" : "remove";
      if (isNew) {
        errors.push(`${module.path}: ${verb} ${name}, a new module can only add`);
        continue;
      }

      const missing = findSymbol(join(repo.service, module.path), name);
      if (missing) errors.push(`${module.path}: ${verb} ${name}, ${missing}`);
    }
  }
  return errors;
}

// add: the symbol must not exist yet
function noCollisions(spec: Spec, repo: Repo): string[] {
  const errors: string[] = [];
  for (const module of spec.modules) {
    if (!isDirectory(join(repo.service, module.path))) continue;

    for (const change of module.changes) {
      if (!("add" in change)) continue;
      if (findSymbol(join(repo.service, module.path), change.add) === null) {
        errors.push(`${module.path}: add ${change.add}, it already exists`);
      }
    }
  }
  return errors;
}

// at → exists or is in the spec and the type is not there yet, from → local path or installed package
function typesResolve(spec: Spec, repo: Repo): string[] {
  const errors: string[] = [];
  const inSpec = new Set(spec.modules.map((module) => module.path));

  for (const type of spec.types) {
    if ("at" in type) {
      const dir = join(repo.service, type.at);
      if (!isDirectory(dir) && !inSpec.has(type.at)) {
        errors.push(`type ${type.name}: at ${type.at}, which does not exist and is not in the spec`);
      } else if (isDirectory(dir) && findSymbol(dir, type.name) === null) {
        errors.push(`type ${type.name}: at ${type.at}, it already exists`);
      }
      continue;
    }

    if (!existsSync(join(repo.service, type.from)) && !isPackageInstalled(repo, type.from)) {
      errors.push(`type ${type.name}: from ${type.from}, which is not a path or an installed package`);
    }
  }
  return errors;
}

// expects → the referenced type has at least that shape, checked by the compiler
function shapesSatisfied(spec: Spec, repo: Repo): string[] {
  const errors: string[] = [];
  for (const type of spec.types) {
    if (!("from" in type) || !type.expects) continue;
    const problem = checkShape(repo, type.name, type.from, type.expects);
    if (problem) errors.push(`type ${type.name}: does not satisfy expects, ${problem}`);
  }
  return errors;
}

// compiles a file that only exists in memory:
//   import type { Customer } from "./src/gateways/crm";
//   type Expected = { id: string; email: string };
//   export const check = (value: Customer): Expected => value;
function checkShape(repo: Repo, name: string, from: string, expects: Record<string, string>): string | null {
  const service = resolve(repo.service);
  const checkFile = join(service, "__plain_shape_check__.ts");
  const specifier = existsSync(join(service, from)) ? `./${from}` : from;
  const fields = Object.entries(expects)
    .map(([key, value]) => `${key}: ${value};`)
    .join(" ");
  const source = [
    `import type { ${name} } from "${specifier}";`,
    `type Expected = { ${fields} };`,
    `export const check = (value: ${name}): Expected => value;`,
  ].join("\n");

  const options: ts.CompilerOptions = { ...COMPILER_OPTIONS, strict: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === checkFile ? ts.createSourceFile(fileName, source, languageVersion) : getSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => fileName === checkFile || fileExists(fileName);

  const program = ts.createProgram([checkFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(checkFile));
  if (diagnostics.length === 0) return null;
  return diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; ");
}

// for → ids from intent
function scenariosLinked(spec: Spec): string[] {
  const errors: string[] = [];
  const ids = new Set(spec.intent.map((scenario) => scenario.id));

  for (const module of spec.modules) {
    for (const change of module.changes) {
      if (!("for" in change)) continue;
      for (const id of change.for) {
        if (!ids.has(id)) errors.push(`${module.path}: for ${id}, which is not a scenario in intent`);
      }
    }
  }
  return errors;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

// looks in node_modules from the service up to the repo root, monorepos hoist packages
function isPackageInstalled(repo: Repo, name: string): boolean {
  let dir = resolve(repo.service);
  const root = resolve(repo.root);
  while (true) {
    if (existsSync(join(dir, "node_modules", name))) return true;
    if (dir === root || dir === dirname(dir)) return false;
    dir = dirname(dir);
  }
}

// files of the module: the directory and its subdirectories, except subdirectories that are modules themselves
function moduleFiles(dir: string): string[] {
  return [...new Bun.Glob("**/*.{ts,tsx}").scanSync(dir)]
    .filter((file) => !file.includes("node_modules/"))
    .filter((file) => !belongsToSubmodule(dir, file))
    .map((file) => join(dir, file));
}

function belongsToSubmodule(dir: string, file: string): boolean {
  let current = dirname(join(dir, file));
  while (current !== dir) {
    if (existsSync(join(current, "AGENTS.md"))) return true;
    current = dirname(current);
  }
  return false;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
};

// returns null when `name` (like "InvoiceList.Row") is exported and defined inside the module (`moduleDir`),
// otherwise the reason it was not found
function findSymbol(moduleDir: string, name: string): string | null {
  const dir = resolve(moduleDir);
  const files = moduleFiles(dir);
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();

  const [head, ...rest] = name.split(".") as [string, ...string[]];

  let symbol: ts.Symbol | undefined;
  for (const file of files) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;

    const exported = checker.getExportsOfModule(moduleSymbol).find((item) => item.name === head);
    if (!exported) continue;

    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (isDefinedIn(target, dir)) {
      symbol = target;
      break;
    }
  }
  if (!symbol) return `${head} is not exported from the module`;

  let path = head;
  for (const member of rest) {
    const next = findMember(checker, symbol, member);
    if (!next) return `${path} has no member ${member}`;
    symbol = next;
    path = `${path}.${member}`;
  }
  return null;
}

function isDefinedIn(symbol: ts.Symbol, dir: string): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    const path = relative(dir, declaration.getSourceFile().fileName);
    return !path.startsWith("..");
  });
}

// namespaces, static members and expando properties (`InvoiceList.Row = ...`), and class instance members
function findMember(checker: ts.TypeChecker, symbol: ts.Symbol, name: string): ts.Symbol | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return (
    symbol.exports?.get(ts.escapeLeadingUnderscores(name)) ??
    (declaration && checker.getTypeOfSymbolAtLocation(symbol, declaration).getProperty(name)) ??
    checker.getDeclaredTypeOfSymbol(symbol).getProperty(name)
  );
}
