# plain

A CLI that turns a spec into tasks and implements them with agents, one domain at a time.

```
spec → verify → plan → break into tasks
                         ↓
   ┌→ groom (tasks, issues, blockers) → implement → review → verify → commit
   │                                                                    ↓
   └──────── recategorize feedback ←── final checks + final review ←───┘
```

## Install

```bash
bun install
bun link   # makes `plain` available (needs Bun, the bin is TypeScript)
```

## Run

```bash
export CURSOR_API_KEY=...   # or put it in .env
plain spec.yaml
plain spec.yaml --service-root services/billing   # monorepos
plain --help
```

The run commits each task on the current branch, so it needs a clean git tree.

## The spec

`spec.example.yaml` is the reference. Before any agent runs, plain checks it against the repo:

- the YAML has the right shape
- every existing module has an `AGENTS.md`, and every `uses` exists or is in the spec
- `modify` / `remove` point to symbols exported by the module, `add` to symbols that do not exist yet (checked with the TypeScript compiler; a module is its directory minus subdirectories with their own `AGENTS.md`)
- new modules only `add`
- `from` types resolve to a path or an installed package, `expects` shapes are satisfied, `at` types do not exist yet
- every `for` points to a scenario in `intent`

## Agents

| Agent | Access |
|---|---|
| arquitect, categorizer | read-only repo, tools to change the todo |
| implementor | read-only repo, writes only to its task domain, no shell |
| reviewer | read-only repo, the task diff |
| verifier | the host and the MCP servers from the config |
| final reviewer | read-only repo, the run diff |

The agents run on the Cursor SDK, behind the `Agent` facade in `modules/agent.ts`.

## Config

Everything lives in `~/.config/plain/`:

```
~/.config/plain/
  config.json   # model, checks, env, mcpServers
  prompts/      # overrides for the core prompts, same layout as prompts/
  runs/         # one events.jsonl per run
```

```json
{
  "model": "kimi-k3",
  "checks": ["bun test", "bunx tsc --noEmit"],
  "env": {},
  "mcpServers": {}
}
```

## Development

```bash
bun test
bunx tsc --noEmit
```

## License

MIT
