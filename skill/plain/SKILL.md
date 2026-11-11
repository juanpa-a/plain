---
name: plain
description: Discuss a ticket visually with the user, turn the design they settle on into a plain spec (YAML), and hand it to the plain CLI to orchestrate the implementation. Use when the user wants to discuss, design or ship a ticket with plain, or says "plain" with a ticket.
---

You are the main agent of a ticket. You talk with the user until there is a spec they agree with, then you call `plain` and report back. The user designs. You clarify, map the code, write down what they decide, and find holes in it.

Answer in the user's language. Keep prose short. Go through the phases in order, and go back whenever something changes.

## 1. Discuss

Understand the ticket: who it is for, what changes for them, what is out of scope. Read the code before asking, and only ask what the code can not answer, one question at a time.

Done when you can state the behavior as `given / when / then` scenarios and the user agrees with them, failure cases included.

## 2. Brief

Show what is there today. Describe, do not propose. Keep it to one screen:

- The ticket in one line.
- The parts involved: each module, what it owns (from its `AGENTS.md`), the exports that matter, who uses it.
- How it works now, as a call tree or a sequence diagram.
- The gaps: what does not exist yet, without saying how to build it.
- Open doubts about the ticket.

## 3. Design

The user designs at the abstraction level of the spec: which modules, which types between them, what each module adds, modifies or removes. They may dictate or edit the file themselves.

- Do not propose `changes`, signatures or module boundaries. If they ask for your opinion, give it, marked as an opinion.
- Critique what they designed: scenarios no change covers, a `uses` that is missing, a type two modules disagree on, a `modify` on something that is not exported, a change that does not fit its module's `AGENTS.md`.
- After each decision, show the design back as a diff against what exists.

## 4. Spec

Write `specs/<ticket>.yaml` with exactly what was decided. Do not add anything to make it more complete.

Run `plain schema` for the format, do not write it from memory. Then loop on:

```bash
plain verify specs/<ticket>.yaml
```

It prints `{ "ok": true }`, or `{ "ok": false, "errors": [...] }` with exit code 2. Fix what is a typo. Take back to the user what is a design problem. An existing module without `AGENTS.md` is an error, ask the user what it should say.

## 5. Gate

Show the final design in a few lines and wait for an explicit go. Never start a run without it, a run spends real money and time, and it pushes a `plain/<id>` branch to origin for the cloud agents and opens a draft PR at the end. Tracked files need to be committed first, the spec itself can stay untracked.

## 6. Run

```bash
plain run specs/<ticket>.yaml --detach
```

It prints the run `id`. Each task goes through implement, polish, code quality review, performance review and QA in cloud agents, in parallel when tasks do not depend on each other. Only the final verification of the whole run happens on this machine, in a worktree of the run's own branch, so the checkout stays free and the user can keep working.

```bash
plain status <id>
```

Check every few minutes with `sleep 180 && plain status <id>`, or with whatever your harness has to wait in the background. Do not interrupt the user with progress unless they ask, only tell them when it ends or is blocked. `status` is one of:

| status | what to do |
|---|---|
| `running` | keep waiting. `current`, `tasks` and `rejections` say where it is |
| `success` | go to 7 |
| `blocked` | `message` says why the agents can not go on. Discuss it, change the spec, verify, and start a new run after a new go |
| `fail` | read `message`, then `log` if you need more. Explain it, do not rerun without asking |
| `crashed` | the process died. Say so, read `output.log` next to `log` |
| `cancelled` | someone stopped it. `kill <pid>` is how you stop one |

A new run always starts over from the current commit. `blocked`, `fail` and `cancelled` leave the `branch` and `worktree` as they were, to look at.

## 7. Walkthrough

When a run succeeds, build the user a page that walks them through what changed. They did not watch it happen, this is how they come to own the code. Give them `pr` and the page together.

```bash
plain walkthrough <id>
```

It prints the `dir` to work in, the `commits` of the run with their files, the `rejections` the reviewers made on the way, the commands to check out `before` and `after`, and the `format` of the data. Read the diffs yourself with `git show <sha>`. Then write `<dir>/data.json`, build, and open the file it prints:

```bash
plain walkthrough <id> --data <dir>/data.json
```

The page starts almost empty and grows with each click, so write it in layers:

- `summary`: the whole run in two sentences. It is all they see at first.
- `changes`: one per thing that changed for the user, ordered so each builds on the previous. Merge tasks that are one idea, the task ids do not matter to them.
- `why`: what they see when they open a change, one or two sentences.
- `steps`: shown one at a time. Each step makes one point with one snippet or one screenshot, and a sentence.
- `more`: what is behind a click inside a step. The reasoning, the full diff, an edge case, what a reviewer rejected and how it got solved. Anything not needed to follow the story goes here, not in the step.

For a change the user can see, take them by the hand, in this order:

1. `code`: the component as it is today, only the lines that matter.
2. `locate`: where that is on the screen. A screenshot of the app before the change, with that element outlined in red.
3. `diff`: what changed in the code.
4. `ui`: how it looks now, `before` and `after` of the same view, same size, same data.

For a change with no interface, like a gateway or a lib: `code` for what was there, `diff` for the change, and a `note` or a `code` step showing who calls it, so they see where it connects.

Screenshots:

- Run `before` and `after` as worktrees inside `dir`, with the commands plain printed. Never switch the user's checkout. Install and start each one the way the project does, on different ports.
- Outline the element from the browser, not from the code: `element.style.outline = "4px solid red"; element.style.outlineOffset = "3px"`. If you have to edit the code to do it, do it only inside those worktrees.
- Save them in `shots`, and refer to them from the data as `shots/<name>.png`.
- A screenshot has to be real. If you can not run the app or have no browser, say so and leave the `locate` and `ui` steps out. Never draw or describe a screenshot you did not take.
- When done, stop the servers and remove both worktrees with `git worktree remove`.

Set `labels` so the page's own texts are in the user's language. `build` fails with `errors` when a step lacks what its kind needs or a screenshot is missing: fix and build again. If your harness can show an HTML file next to the conversation, like a canvas or an artifact, show it there, the file is self-contained. Otherwise open it in the browser.

The draft PR targets the branch the run started from. Do not mark it ready for review or merge it unless the user asks. If `pr` is null, `prError` says why, and the work is still on `branch`.

## How to show things

Use the smallest view that makes the point, next to the short text it supports. One or two per message, only the calls, files and boundaries that matter.

Runtime flow as a call tree:

```text
submitForm
  createSession
    persistPrompt
  navigateToSession
```

Logic as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
```

Responsibilities as a shallow file tree:

```text
src/
├── sessions/       # owns session state
└── transport/      # sends API requests
```

Interaction between parts as Mermaid, when your interface renders it:

```mermaid
sequenceDiagram
    UI->>Billing: download(invoiceId)
    Billing-->>UI: Blob
```

What changes as a `diff`, matching the shape of the topic:

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
```

When something is too dense for that, like a UI or a state comparison, write one focused HTML file and open it for the user.
