import {
  Agent as CursorAgent,
  Cursor,
  CursorSdkError,
  readOnlyFs,
  unionFs,
  type FileSystem,
  type McpServerConfig,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
  type SDKCustomToolResult,
} from "@cursor/sdk";
import { z } from "zod";

import { LIMIT_MAX_WAITS, LIMIT_RETRY_DELAY_MS, MAX_RETRIES, RETRY_DELAY_MS } from "../constants";
import { diskFs } from "./disk-fs";
import type { Domain } from "./domain";
import type { RunLog } from "./run-log";
import type { Workspace } from "./workspace";

const VerdictSchema = z.object({
  approved: z.boolean(),
  notes: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

// a function the model can call while it works
export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON schema of the input
  run: (input: unknown) => string | void;
};

// thrown by a tool when the model sent something wrong, the message goes back to the model
export class ToolError extends Error {}

export function defineTool<Schema extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: Schema;
  run: (input: z.infer<Schema>) => string | void;
}): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input),
    run: (raw) => {
      const parsed = tool.input.safeParse(raw);
      if (!parsed.success) {
        throw new ToolError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
      }
      return tool.run(parsed.data);
    },
  };
}

// what the agent can touch:
// read → the service read-only, domain → only its domain is writable, host → the machine as is (shell included)
export type Access = { kind: "read" } | { kind: "domain"; domain: Domain } | { kind: "host" };

type Options = {
  label: string; // shows up in the log, like "implementor:task-1"
  tools?: Tool[];
  access?: Access;
  mcp?: boolean; // gives the agent the mcp servers from the config
};

// facade over the cursor sdk, the rest of plain only knows this class
export class Agent {
  private tools: Tool[];
  private access: Access;

  constructor(
    private role: string,
    private log: RunLog,
    private workspace: Workspace,
    private options: Options,
  ) {
    this.tools = options.tools ?? [];
    this.access = options.access ?? { kind: "read" };
  }

  public async prompt(step: string, message: string): Promise<string> {
    return this.run(step, message, this.tools);
  }

  // like prompt, but the agent has to reply with a verdict through a tool call
  public async judge(step: string, message: string): Promise<Verdict> {
    let verdict: Verdict = { approved: false, notes: "the agent did not submit a verdict" };
    const submitVerdict = defineTool({
      name: "submitVerdict",
      description: "submit your final verdict, call it exactly once at the end",
      input: VerdictSchema,
      run: (input) => {
        verdict = input;
      },
    });

    await this.run(step, message, [...this.tools, submitVerdict]);
    this.log.write("verdict", { agent: this.options.label, step, ...verdict });
    return verdict;
  }

  private async run(step: string, message: string, tools: Tool[]): Promise<string> {
    const agent = this.options.label;
    this.log.write("prompt", { agent, step, role: this.role, message, tools: tools.map((tool) => tool.name) });

    const result = await this.send(agent, step, message, tools);
    this.log.write("response", {
      agent,
      step,
      status: result.status,
      response: result.result ?? "",
      error: result.error,
      usage: result.usage,
      durationMs: result.durationMs,
    });

    if (result.status === "error") this.log.fail(`${agent} ${step}: cursor run failed, ${result.error?.message}`);
    return result.result ?? "";
  }

  private send(agent: string, step: string, message: string, tools: Tool[]): Promise<RunResult> {
    // the role goes at the top of the message instead of `systemPrompt`,
    // that option needs to be enabled per cursor account
    return retrying(this.log, agent, step, () =>
      CursorAgent.prompt(`${this.role}\n\n${message}`, {
        apiKey: Bun.env.CURSOR_API_KEY,
        model: { id: this.workspace.getModel() },
        mcpServers: this.options.mcp ? (this.workspace.getMcpServers() as Record<string, McpServerConfig>) : undefined,
        local: {
          cwd: this.workspace.getServiceRoot(),
          settingSources: [], // ignore the repo and user cursor rules
          customTools: this.toCursorTools(agent, step, tools),
          fs: this.fileSystem(),
        },
      }),
    );
  }

  // every call is logged, a ToolError goes back to the model so it can fix its input
  private toCursorTools(agent: string, step: string, tools: Tool[]): Record<string, SDKCustomTool> {
    return Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema as SDKCustomTool["inputSchema"],
          execute: (args): SDKCustomToolResult => {
            try {
              const result = tool.run(args) ?? "ok";
              this.log.write("tool", { agent, step, tool: tool.name, args, result });
              return result;
            } catch (error) {
              if (!(error instanceof ToolError)) throw error;
              this.log.write("tool", { agent, step, tool: tool.name, args, error: error.message });
              return { content: [{ type: "text", text: error.message }], isError: true };
            }
          },
        },
      ]),
    );
  }

  private fileSystem(): FileSystem | undefined {
    const service = this.workspace.getServiceRoot();
    switch (this.access.kind) {
      case "host":
        return undefined;
      case "read":
        return readOnlyFs(diskFs(service));
      case "domain":
        return unionFs({
          "/": readOnlyFs(diskFs(service)),
          [`/${this.access.domain}`]: diskFs(`${service}/${this.access.domain}`),
        });
    }
  }
}

type CloudOptions = {
  label: string;
  startingRef: string; // the branch it clones. What it pushes goes to a branch of its own, see getPushBranch
  mcp?: boolean; // gives the agent the mcp servers from the config
};

// an agent on a cursor cloud vm, it keeps its conversation and branch between sends
export class CloudAgent {
  private agent: SDKAgent | null = null;
  private run: Run | null = null;
  private branch: string | null = null;

  constructor(
    private role: string,
    private log: RunLog,
    private workspace: Workspace,
    private options: CloudOptions,
  ) {}

  // returns the branch with the work, null when the agent pushed nothing.
  // The sdk does not always report what the agent pushed, so plain names the branch and checks origin
  public async work(step: string, message: string): Promise<string | null> {
    const target = this.getPushBranch();
    const before = this.workspace.getRemoteHead(target);
    await this.send(step, `${message}

      when you are done, commit and push your work with: git push --force origin HEAD:refs/heads/${target}
      push to no other branch`);
    if (this.workspace.getRemoteHead(target) !== before) this.branch = target;
    return this.branch;
  }

  // one branch per agent, next to the run branch (a ref can not live under it)
  private getPushBranch(): string {
    return `${this.workspace.getBranch()}-${this.options.label.replace(/[^\w-]/g, "-")}`;
  }

  // custom tools do not reach the cloud, so the verdict comes in the final message
  public async judge(step: string, message: string): Promise<Verdict> {
    const verdict = parseVerdict((await this.send(step, message)).result ?? "");
    this.log.write("verdict", { agent: this.options.label, step, ...verdict });
    return verdict;
  }

  // stops what is running so it does not keep spending
  public async cancel(): Promise<void> {
    await this.run?.cancel().catch(() => {});
    this.run = null;
  }

  // archived, so a finished agent does not hold one of the slots of the plan
  public close(): void {
    if (!this.agent) return;
    const id = this.agent.agentId;
    this.agent.close();
    this.agent = null;
    CursorAgent.archive(id).catch((error) => this.log.write("archive-failed", { agent: this.options.label, error: (error as Error).message }));
  }

  private async send(step: string, message: string): Promise<RunResult> {
    const agent = this.options.label;
    this.log.write("prompt", { agent, step, role: this.role, message, tools: [] });

    const isFirst = this.agent === null;
    const cloudAgent = await this.getAgent();
    const key = crypto.randomUUID(); // a retry of the same send must not start a second run
    const run = await retrying(this.log, agent, step, () =>
      cloudAgent.send(isFirst ? `${this.role}\n\n${message}` : message, { idempotencyKey: key }),
    );
    this.run = run;
    const result = await retrying(this.log, agent, step, () => run.wait());
    this.run = null;

    this.log.write("response", {
      agent,
      step,
      status: result.status,
      response: result.result ?? "",
      error: result.error,
      usage: result.usage,
      durationMs: result.durationMs,
      cloudAgent: cloudAgent.agentId,
      branch: this.branch,
    });

    if (result.status !== "finished") this.log.fail(`${agent} ${step}: cloud run ${result.status}, ${result.error?.message}`);
    return result;
  }

  private async getAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;

    const key = crypto.randomUUID();
    this.agent = await retrying(this.log, this.options.label, "CREATE", () =>
      CursorAgent.create({
        apiKey: Bun.env.CURSOR_API_KEY,
        model: { id: this.workspace.getCloudModel() },
        idempotencyKey: key,
        mcpServers: this.options.mcp ? (this.workspace.getMcpServers() as Record<string, McpServerConfig>) : undefined,
        cloud: {
          repos: [{ url: this.workspace.getRepoUrl() ?? "", startingRef: this.options.startingRef }],
          autoCreatePR: false,
          metadata: { plainRun: this.workspace.getBranch() ?? "", plainAgent: this.options.label },
        },
      }),
    );
    return this.agent;
  }
}

// the last json block of the message that is a verdict, anything else counts as a rejection
export function parseVerdict(text: string): Verdict {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "").reverse();
  for (const candidate of [...blocks, text]) {
    try {
      const parsed = VerdictSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // not json, try the next one
    }
  }
  return { approved: false, notes: "the agent did not end with a verdict in the expected format" };
}

// why the cloud agents can not clone the repo, null when Cursor has it connected
export async function cloudAccessProblem(
  repoUrl: string,
  listRepositories: () => Promise<{ url: string }[]> = () => Cursor.repositories.list(),
): Promise<string | null> {
  const normalize = (url: string) => url.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  let connected: { url: string }[];
  try {
    connected = await listRepositories();
  } catch (error) {
    return `could not ask Cursor for its repositories: ${(error as Error).message}`;
  }
  if (connected.some((repo) => normalize(repo.url) === normalize(repoUrl))) return null;
  return `Cursor can not reach ${repoUrl}: give its GitHub app access to the repository (cursor.com/dashboard → Integrations → GitHub)`;
}

export function isAgentLimit(message: string): boolean {
  return /reached the limit|run more cloud agents simultaneously/i.test(message);
}

// retries the errors the sdk marks as retryable (network, rate limits...) and waits out the agent limit of the plan
async function retrying<T>(log: RunLog, agent: string, step: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const message = (error as Error).message;
      // the plan caps how many cloud agents run at once, a slot frees when another agent ends
      const atLimit = isAgentLimit(message);
      const retryable = atLimit || (error instanceof CursorSdkError && error.isRetryable);
      if (!retryable || attempt >= (atLimit ? LIMIT_MAX_WAITS : MAX_RETRIES)) {
        log.fail(`${agent} ${step}: ${message}`);
      }
      log.write("retry", { agent, step, attempt, error: message });
      await Bun.sleep(atLimit ? LIMIT_RETRY_DELAY_MS : RETRY_DELAY_MS * attempt);
    }
  }
}
