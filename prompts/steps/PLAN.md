# PLAN

category: step

Write the plan to build the spec. No code. For each module of the spec, in the order they have to be built:

- what changes in it, with the signatures from the spec
- the files it will likely touch, from what you read
- what it needs from other modules, and which ones need it
- the tests that prove the scenarios it serves (`for`)

End with the risks: anything in the spec that looks hard to fit the current code. If something can not be built with the current abstractions, say which and why, it becomes a blocker in the next step.
