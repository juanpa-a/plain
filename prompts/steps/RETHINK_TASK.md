# RETHINK_TASK

category: step

An issue was raised on a task while refining it. Solve it, then call `resolveIssue`.

- If the task was routed wrong or is really several changes, fix the todo with the current abstractions: add the tasks that express the intent, each in the right domain and with the right `dependsOn`, and refine or reopen what is left of the original.
- If the abstractions in the repository can not express what the spec needs, do not invent new ones and do not change the spec. Call `addBlocker` with the abstractions involved and why they can not express it, so the developer decides. Then resolve the issue.
