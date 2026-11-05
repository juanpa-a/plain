# REFINE_TASK_DEFINITION

category: step

## Notes

it should:
  - route the ticket on only one atomic change contained in 1 directory
  - enrich the task using the AGENT.md fiel form the directory it routed the task to

it should be limited to tickets only but if ones is closed or needs to be moved to another,
we should have a mathod to raise this issues, maybe Todo.addIssue , and we could define issues as plan time
issues that another agent pass should solve and tasks as things ready to be picked up by an agent, we will also need
another problem name for this that need to be raised to the developer, for example when the current abtractions cannot
express the current implementation needed, and it needs to be extended
