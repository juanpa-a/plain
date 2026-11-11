# plain

A CLI that turns a spec into tasks and implements them with agents, one domain at a time. You discuss the ticket with your coding agent (Claude Code, Cursor) through the `plain` skill, and that agent calls the CLI once you agree on the design.

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

```bash
plain install-skill   # for Claude Code and Cursor
```

## Use it from your agent

Ask your agent to use the `plain` skill on a ticket. It clarifies the ticket, shows you what exists today, writes down the design you decide, and leaves it in `specs/<ticket>.yaml`. After your go, it starts the run and tells you when it ends or needs you.

After a successful run it hands you the draft PR and a walkthrough: a page that starts with two sentences and grows as you click, taking each change step by step with the code before, where it is on the screen (outlined in red), the diff, and the UI before and after.

## Run

```bash
export CURSOR_API_KEY=...   # or put it in .env
plain verify specs/ticket.yaml                # check the spec, no agents
plain run specs/ticket.yaml                   # in the foreground
plain run specs/ticket.yaml --detach          # in the background, prints the run id
plain status <id>                             # where it is, as json
plain schema                                  # the spec format
plain walkthrough <id>                        # what a run changed, to build its walkthrough page
plain run specs/ticket.yaml --service-root services/billing   # monorepos
plain --help
```

Each run works on its own branch, `plain/<id>`, in a worktree under `~/.config/plain/runs/<id>/`, with one commit per task. Your checkout stays free. Tracked files need to be committed before starting, untracked files like the spec are fine. On success the worktree is removed and the branch stays.

The implementors run in Cursor cloud agents, so the repo needs an `origin` Cursor can reach: its GitHub app needs access to the repository, plain checks it before starting. plain pushes `plain/<id>` there, each agent starts from it and pushes to a branch plain names for it, like `plain/<id>-implementor-t1`, which plain checks on origin. Tasks run in parallel unless one depends on another or they share a domain.

Each task goes through implement → polish → code quality review → performance review → QA, each step in a cloud agent of its own. The first rejection sends the notes back to the implementor, for at most 3 rounds, so a task costs up to 15 cloud runs. An approved result is squashed into `plain/<id>` and pushed. The checks, the final review and the verifier run once, on your machine, over the whole run. plain leaves the agent branches on origin.

When the run succeeds, plain opens a draft PR from `plain/<id>` to the branch you started from, with `gh`, so it has to be installed and logged in. `plain status` reports its url in `pr`. If it can not be opened the run still counts as a success, `prError` says why.

Exit codes: `0` ok, `1` failed, `2` invalid spec, `3` blocked, needs a human.

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
| implementor, polisher | a cloud VM with the repo, the diff is rejected if it leaves the task domain (`local` implementor: writes only to its domain, no shell) |
| quality reviewer, performance reviewer | a cloud VM with the repo, what they push is ignored |
| qa | a cloud VM with the repo and the MCP servers from the config, what it pushes is ignored |
| final verifier | the host and the MCP servers from the config |
| final reviewer | read-only repo, the run diff |

The agents run on the Cursor SDK, behind the `Agent` facade in `modules/agent.ts`.

## Config

Everything lives in `~/.config/plain/`:

```
~/.config/plain/
  config.json   # model, checks, env, mcpServers
  prompts/      # overrides for the core prompts, same layout as prompts/
  runs/         # one folder per run: events.jsonl, output.log, worktree, walkthrough
```

```json
{
  "model": "kimi-k3",
  "implementors": "cloud",
  "cloudModel": null,
  "concurrency": 4,
  "setup": ["bun install"],
  "checks": ["bun test", "bunx tsc --noEmit"],
  "env": {},
  "mcpServers": {}
}
```

`implementors: "local"` runs each task on your machine one at a time, with a local reviewer and verifier instead of the cloud steps, and needs no remote. `cloudModel` is the model of the cloud implementors, by default the same as `model`. `setup` runs once in the worktree of each run. A worktree starts without `node_modules`, so this is where dependencies get installed.

## Development

```bash
bun test
bunx tsc --noEmit
```

## License

MIT
