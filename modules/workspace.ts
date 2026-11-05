import { DEFAULT_MODEL } from "../constants";
import type { Repo } from "./spec";

export type Diff = string;

export type CheckFailure = {
  command: string;
  output: string;
};

type Config = {
  model: string;
  checks: string[]; // "bun test", "bunx tsc --noEmit"...
  env: Record<string, string>;
  mcpServers: Record<string, unknown>; // given to the verifier, same shape as cursor's mcp config
};

const DEFAULT_CONFIG: Config = { model: DEFAULT_MODEL, checks: [], env: {}, mcpServers: {} };

export class Workspace {
  private base: string = "";

  constructor(
    private config: Config,
    private repo: Repo,
  ) {}

  // missing fields fall back to the defaults
  public static async load(path: string, repo: Repo): Promise<Workspace> {
    const file = Bun.file(path);
    const config: Partial<Config> = (await file.exists()) ? await file.json() : {};
    return new Workspace({ ...DEFAULT_CONFIG, ...config }, repo);
  }

  public getModel(): string {
    return this.config.model;
  }

  public getMcpServers(): Record<string, unknown> {
    return this.config.mcpServers;
  }

  public getRepo(): Repo {
    return this.repo;
  }

  public getServiceRoot(): string {
    return this.repo.service;
  }

  public getEnvDetails(): string {
    return JSON.stringify(this.config.env);
  }

  // the run commits on the current branch, so it has to start from a clean tree
  public startRun(): string | null {
    if (this.git("rev-parse", "--is-inside-work-tree").exitCode !== 0) return "the service is not inside a git repository";
    if (this.git("status", "--porcelain").stdout.trim() !== "") return "the working tree has uncommitted changes";
    this.base = this.git("rev-parse", "HEAD").stdout.trim();
    return null;
  }

  // what the current task changed, untracked files included
  public getTaskDiff(): Diff {
    this.git("add", "--all", ".");
    return this.git("diff", "--cached").stdout;
  }

  // everything the run changed since it started
  public getRunDiff(): Diff {
    this.git("add", "--all", ".");
    return this.git("diff", "--cached", this.base).stdout;
  }

  public commit(message: string): void {
    this.git("add", "--all", ".");
    this.git("commit", "--allow-empty", "--message", message);
  }

  public runChecks(): CheckFailure[] {
    const failures: CheckFailure[] = [];
    for (const command of this.config.checks) {
      const result = Bun.spawnSync(["sh", "-c", command], { cwd: this.repo.service });
      if (result.exitCode !== 0) {
        failures.push({ command, output: result.stdout.toString() + result.stderr.toString() });
      }
    }
    return failures;
  }

  private git(...args: string[]): { exitCode: number; stdout: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd: this.repo.service });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  }
}
