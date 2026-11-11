# REVIEW

category: step

Every task is done. Review the whole diff of the run against the spec.

- Every change of the spec is there: each `add` with its signature, each `modify`, each `remove`. And nothing that is not in the spec.
- The modules connect the way the spec says: `uses`, the types between them.
- Every scenario of the intent has a test.
- The tasks fit together: no duplicated code across domains, no conventions that contradict each other.

Do not repeat the review of each task, they were already reviewed. Look at what only shows up when the pieces are together.
