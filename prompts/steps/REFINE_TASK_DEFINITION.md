# REFINE_TASK_DEFINITION

category: step

Make this task ready to be picked up, then call `refineTask` once.

1. Check the routing: the task has to be one atomic change inside its `domain`. If it needs changes in another directory, or it is really two changes, do not refine it: raise an `addIssue` on it explaining what is wrong.
2. Read the `AGENTS.md` of its domain and the code it touches, and rewrite the `description` with what an implementor needs: the files, the conventions of the domain that apply, the signatures, the edge cases, the tests to write. Keep the title as the first line.
3. Write its `intent`: scenarios in given / when / then specific to this task, concrete enough to be tests. Keep the ids of the spec scenarios it serves where they apply.
