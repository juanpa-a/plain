import { appendFileSync, mkdirSync } from "node:fs";

type Event = {
  at: string;
  step: string;
  data: unknown;
};

export type RunStatus = "success" | "fail" | "blocked" | "cancelled";

// what `plain status` answers
export type RunReport = {
  id: string;
  status: RunStatus | "running" | "crashed"; // crashed: it did not finish and the process is gone
  pid: number | null;
  spec: string | null;
  branch: string | null;
  base: string | null; // the commit the run started from
  worktree: string | null; // null once the run removed it
  pr: string | null; // the url of the draft pr, once the run succeeded
  prError: string | null; // why there is no pr
  current: string | null; // the last thing an agent was asked to do
  tasks: { id: string; domain: string; title: string; isDone: boolean; isRunning: boolean }[];
  rejections: { agent: string; step: string; notes: string }[]; // the latest ones
  message: string | null;
  log: string;
};

const RECENT_REJECTIONS = 3;

// thrown by fail(), the entry point catches it to close the run
export class RunFailed extends Error {}

// thrown by block(), the agents need a human decision to go on
export class RunBlocked extends RunFailed {}

export class RunLog {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  public getDir(): string {
    return this.dir;
  }

  public getPath(): string {
    return `${this.dir}/events.jsonl`;
  }

  public write(step: string, data: unknown): void {
    const event: Event = { at: new Date().toISOString(), step, data };
    appendFileSync(this.getPath(), JSON.stringify(event) + "\n");
  }

  // the first event of every run: what it ran with
  public start(data: unknown): void {
    this.write("start", data);
  }

  // the last event of every run: how it ended
  public finish(status: RunStatus, data: unknown): void {
    this.write("finish", { status, ...(data as object) });
  }

  // writes the error and stops the run
  public fail(reason: string): never {
    this.write("fail", { reason });
    throw new RunFailed(reason);
  }

  // writes why a human is needed and stops the run
  public block(reason: string): never {
    this.write("blocked", { reason });
    throw new RunBlocked(reason);
  }
}

// null when the run does not exist
export async function readRunReport(id: string, dir: string, rejections: number = RECENT_REJECTIONS): Promise<RunReport | null> {
  const log = `${dir}/events.jsonl`;
  const file = Bun.file(log);
  if (!(await file.exists())) return null;

  const events = (await file.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
  // the data of the last event of that step
  const last = (step: string): any => events.findLast((event) => event.step === step)?.data;

  const finish = last("finish");
  const prompt = last("prompt");
  const workspace = last("workspace");
  const pid: number | null = last("start")?.pid ?? last("detached")?.pid ?? null;

  return {
    id,
    status: finish?.status ?? (pid !== null && isAlive(pid) ? "running" : "crashed"),
    pid,
    spec: last("start")?.spec ?? null,
    branch: workspace?.branch ?? null,
    base: workspace?.base ?? null,
    worktree: finish ? (finish.worktree ?? null) : (workspace?.worktree ?? null),
    pr: finish?.pr ?? null,
    prError: finish?.prError ?? null,
    current: prompt ? `${prompt.agent} ${prompt.step}` : null,
    tasks: last("todo")?.tasks ?? [],
    rejections: events
      .filter((event) => event.step === "verdict" && !(event.data as { approved: boolean }).approved)
      .slice(-rejections)
      .map((event) => {
        const { agent, step, notes } = event.data as { agent: string; step: string; notes: string };
        return { agent, step, notes };
      }),
    message: finish?.message ?? null,
    log,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
