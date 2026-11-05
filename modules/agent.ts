import {
  Agent as CursorAgent,
  CursorSdkError,
  readOnlyFs,
  unionFs,
  type FileSystem,
  type McpServerConfig,
  type RunResult,
  type SDKCustomTool,
  type SDKCustomToolResult,
} from "@cursor/sdk";
import { z } from "zod";

import { MAX_RETRIES, RETRY_DELAY_MS } from "../constants";
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

  // retries the errors the sdk marks as retryable (network, rate limits...)
  private async send(agent: string, step: string, message: string, tools: Tool[]): Promise<RunResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        // the role goes at the top of the message instead of `systemPrompt`,
        // that option needs to be enabled per cursor account
        return await CursorAgent.prompt(`${this.role}\n\n${message}`, {
          apiKey: Bun.env.CURSOR_API_KEY,
          model: { id: this.workspace.getModel() },
          mcpServers: this.options.mcp ? (this.workspace.getMcpServers() as Record<string, McpServerConfig>) : undefined,
          local: {
            cwd: this.workspace.getServiceRoot(),
            settingSources: [], // ignore the repo and user cursor rules
            customTools: this.toCursorTools(agent, step, tools),
            fs: this.fileSystem(),
          },
        });
      } catch (error) {
        const retryable = error instanceof CursorSdkError && error.isRetryable;
        if (!retryable || attempt >= MAX_RETRIES) {
          this.log.fail(`${agent} ${step}: ${(error as Error).message}`);
        }
        this.log.write("retry", { agent, step, attempt, error: (error as Error).message });
        await Bun.sleep(RETRY_DELAY_MS * attempt);
      }
    }
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

