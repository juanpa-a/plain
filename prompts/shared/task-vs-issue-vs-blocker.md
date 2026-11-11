# task-vs-issue-vs-blocker

category: shared

The todo holds three kinds of things:

- task: one atomic change inside one domain, ready for an implementor to pick up.
- issue: a problem with a task found while planning, like a task routed to the wrong domain or that is really two changes. Another pass solves it with the current abstractions.
- blocker: something only the developer can decide, like the abstractions of the repository not being able to express what the spec needs. It stops the run. Say which abstractions are involved and why.
