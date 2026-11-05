import { appendFileSync, mkdirSync } from "node:fs";

type Event = {
  at: string;
  step: string;
  data: unknown;
};

export type RunStatus = "success" | "fail" | "cancelled";

// thrown by fail(), the entry point catches it to close the run
export class RunFailed extends Error {}

export class RunLog {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
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
}
