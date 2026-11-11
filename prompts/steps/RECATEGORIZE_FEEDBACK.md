# RECATEGORIZE_FEEDBACK

category: step

The final checks, the final review or the final verification over the whole run found something. Turn it into work.

- Failed checks are facts: each one has to end up in a task. Read the output to find which domain it belongs to.
- Review and verification notes are opinions about the result. Act on the ones that point to a real problem against the spec, discard the rest.
- When the problem is in the work of a done task, `reopenTask` with notes that say exactly what to fix. Add a new task only for work no task covers, after the tasks it depends on.
- If fixing it needs abstractions the repository does not have, `addBlocker`.
