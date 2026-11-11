# BREAK_INTO_TASKS

category: step

Turn the plan into tasks with `addTask`.

- A task is one atomic change inside one domain: a directory with its own `AGENTS.md`, or a module path of the spec. One module of the spec is usually one task. Split it only when the parts can be built and reviewed on their own.
- `id`: t1, t2, t3... in the order you add them.
- `description`: first line is a short title of what changes for the user of the module. Then what to build, with the signatures from the spec, the files to touch and the tests to write. Enough for someone who never saw the spec.
- `for`: the ids of the spec scenarios the task serves.
- `dependsOn`: the tasks whose result this one needs, for example a module that uses a function another task adds. Add a task after the tasks it depends on. Tasks with no dependency between them run at the same time, so do not add dependencies that are not real.

If the plan found something the current abstractions can not express, call `addBlocker` with why and the abstractions involved, and add no tasks for it.
