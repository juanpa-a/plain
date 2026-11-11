import { realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { DEFAULT_CONCURRENCY, DEFAULT_MODEL } from "../constants";
import type { Repo } from "./spec";

export type Diff = string;

export type PullRequest = {
  title: string;
  body: string;
};

// a run that worked is still a run that worked if the pr could not be opened
export type PullRequestResult = {
  url: string | null;
  error: string | null;
};

export type CheckFailure = {
  command: string;
  output: string;
};

type Config = {
  model: string;
  implementors: "cloud" | "local"; // local: one at a time, on this machine
  cloudModel: string | null; // the cloud implementors' model, null: the same as `model`
  concurrency: number; // how many cloud implementors at the same time
  setup: string[]; // runs once in the worktree of each run, "bun install"...
  checks: string[]; // "bun test", "bunx tsc --noEmit"...
  env: Record<string, string>;
  mcpServers: Record<string, unknown>; // given to the verifier, same shape as cursor's mcp config
};

const DEFAULT_CONFIG: Config = {
  model: DEFAULT_MODEL,
  implementors: "cloud",
  cloudModel: null,
  concurrency: DEFAULT_CONCURRENCY,
  setup: [],   checks: [],
  env: {},
  mcpServers: {},
};

export class Workspace {
  private base: string = "";
  private branch: string | null = null;
  private worktree: string | null = null;
  private checkout: Repo | null = null; // where the run came from
  private servicePrefix: string = ""; // the service inside the repo
  private baseBranch: string = ""; // the branch the run came from, what the pr targets

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

  public getCloudModel(): string {
    return this.config.cloudModel ?? this.config.model;
  }

  public usesCloud(): boolean {
    return this.config.implementors === "cloud";
  }

  public getConcurrency(): number {
    return this.config.concurrency;
  }

  // the url of origin in the form the cloud agents clone, null when it is not a hosted repository
  public getRepoUrl(): string | null {
    const url = this.git("config", "--get", "remote.origin.url").stdout.trim();
    const scp = url.match(/^[^@/]+@([^:/]+):(.+)$/);
    if (scp) return `https://${scp[1]}/${scp[2]!.replace(/\.git$/, "")}`;
    const hosted = url.match(/^(?:https|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
    return hosted ? `https://${hosted[1]}/${hosted[2]!.replace(/\.git$/, "")}` : null;
  }

  // a path of the repo, for what git reports from the root
  public getRepoPath(domain: string): string {
    return join(this.servicePrefix, domain).replace(/\/$/, "");
  }

  public getServiceRoot(): string {
    return this.repo.service;
  }

  public getEnvDetails(): string {
    return JSON.stringify(this.config.env);
  }

  // the commit the run started from
  public getBase(): string | null {
    return this.base || null;
  }

  public getBranch(): string | null {
    return this.branch;
  }

  public getWorktree(): string | null {
    return this.worktree;
  }

  // the reason a run can not start, untracked files are fine: the spec usually is one
  public canStart(): string | null {
    if (this.git("rev-parse", "--is-inside-work-tree").exitCode !== 0) return "the service is not inside a git repository";
    if (this.git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") return "the working tree has uncommitted changes";
    if (this.usesCloud() && !this.getRepoUrl()) return "cloud implementors need an origin remote on a hosted repository";
    return null;
  }

  // moves the run to its own branch and worktree, the checkout stays as it is
  public startRun(id: string, worktree: string): string | null {
    const problem = this.canStart();
    if (problem) return problem;

    const base = this.git("rev-parse", "HEAD").stdout.trim();
    this.baseBranch = this.git("branch", "--show-current").stdout.trim();
    const branch = `plain/${id}`;
    const added = this.git("worktree", "add", "--quiet", "-b", branch, worktree, base);
    if (added.exitCode !== 0) return `could not create the worktree: ${added.stderr.trim()}`;

    this.base = base;
    this.branch = branch;
    this.worktree = worktree;
    this.checkout = this.repo;
    this.servicePrefix = relative(realpathSync(this.repo.root), realpathSync(this.repo.service));
    this.repo = { root: worktree, service: join(worktree, this.servicePrefix) };

    for (const command of this.config.setup) {
      const result = this.shell(command);
      if (result.exitCode !== 0) return `setup failed: ${command}\n${result.output}`;
    }
    return this.usesCloud() ? this.pushRun() : null;
  }

  // publishes the run branch, where the cloud implementors start from. The reason when it could not
  public pushRun(): string | null {
    // forced: plain owns the run branch, whatever an agent pushed there is not the run
    const pushed = this.git("push", "--quiet", "--force", "origin", this.branch ?? "");
    return pushed.exitCode === 0 ? null : `could not push ${this.branch}: ${pushed.stderr.trim()}`;
  }

  // pushes the run branch and opens a draft pr against the branch the run came from
  public openDraftPr(pr: PullRequest): PullRequestResult {
    if (!this.getRepoUrl()) return { url: null, error: "no hosted origin, the branch stayed local" };
    const problem = this.pushRun();
    if (problem) return { url: null, error: problem };

    const base = this.baseBranch ? ["--base", this.baseBranch] : []; // detached HEAD: the default branch of the repo
    const args = ["gh", "pr", "create", "--draft", "--head", this.branch ?? "", ...base, "--title", pr.title, "--body", pr.body];
    try {
      const result = Bun.spawnSync(args, { cwd: this.repo.service, env: process.env });
      if (result.exitCode !== 0) return { url: null, error: `gh pr create failed: ${result.stderr.toString().trim()}` };
      return { url: result.stdout.toString().trim().split("\n").at(-1) ?? null, error: null };
    } catch (error) {
      return { url: null, error: `gh pr create failed: ${(error as Error).message}` };
    }
  }

  // why the branch can not be taken for that domain, null when it can
  public checkBranch(branch: string, domain: string): string | null {
    if (branch === this.branch) return `the work has to be on its own branch, not on ${branch}`;
    const fetched = this.git("fetch", "--quiet", "origin", branch);
    if (fetched.exitCode !== 0) return `could not fetch ${branch}: ${fetched.stderr.trim()}`;

    const allowed = `${this.getRepoPath(domain)}/`;
    const outside = this.git("diff", "--name-only", "HEAD...FETCH_HEAD")
      .stdout.split("\n")
      .filter((file) => file !== "" && !file.startsWith(allowed));
    return outside.length > 0 ? `you changed files outside ${allowed}, undo them: ${outside.join(", ")}` : null;
  }

  // leaves the work of a branch staged in the worktree, or returns why it can not be taken
  public applyBranch(branch: string, domain: string): string | null {
    const refused = this.checkBranch(branch, domain);
    if (refused) return refused;

    if (this.git("merge", "--squash", "FETCH_HEAD").exitCode !== 0) {
      this.discard();
      return `your branch conflicts with ${this.branch}, rebase it on that branch and solve the conflicts`;
    }
    return null;
  }

  // back to the last commit of the run
  public discard(): void {
    this.git("reset", "--quiet", "--hard", "HEAD");
    this.git("clean", "--quiet", "-fd");
  }

  // removes the worktree, the branch stays. A worktree with leftovers is kept
  public closeRun(): void {
    if (!this.worktree || !this.checkout) return;
    const worktree = this.worktree;
    this.repo = this.checkout;
    if (this.git("worktree", "remove", worktree).exitCode === 0) this.worktree = null;
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
      const result = this.shell(command);
      if (result.exitCode !== 0) failures.push({ command, output: result.output });
    }
    return failures;
  }

  private shell(command: string): { exitCode: number; output: string } {
    const result = Bun.spawnSync(["sh", "-c", command], { cwd: this.repo.service });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  // the commit a branch of origin points to, null when it does not exist
  public getRemoteHead(branch: string): string | null {
    const listed = this.git("ls-remote", "origin", `refs/heads/${branch}`);
    return listed.exitCode === 0 ? (listed.stdout.split(/\s/)[0] || null) : null;
  }

  private git(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd: this.repo.service });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
}
