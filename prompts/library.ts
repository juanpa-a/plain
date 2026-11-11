import PLAN from "./steps/PLAN.md" with { type: "text" };
import BREAK_INTO_TASKS from "./steps/BREAK_INTO_TASKS.md" with { type: "text" };
import REFINE_TASK_DEFINITION from "./steps/REFINE_TASK_DEFINITION.md" with { type: "text" };
import RETHINK_TASK from "./steps/RETHINK_TASK.md" with { type: "text" };
import REVIEW from "./steps/REVIEW.md" with { type: "text" };
import RECATEGORIZE_FEEDBACK from "./steps/RECATEGORIZE_FEEDBACK.md" with { type: "text" };

import arquitect from "./roles/arquitect.md" with { type: "text" };
import categorizer from "./roles/categorizer.md" with { type: "text" };
import implementor from "./roles/implementor.md" with { type: "text" };
import reviewer from "./roles/reviewer.md" with { type: "text" };
import verifier from "./roles/verifier.md" with { type: "text" };
import polisher from "./roles/polisher.md" with { type: "text" };
import qualityReviewer from "./roles/quality-reviewer.md" with { type: "text" };
import performanceReviewer from "./roles/performance-reviewer.md" with { type: "text" };
import qa from "./roles/qa.md" with { type: "text" };

import { PROMPTS_OVERRIDES_DIR } from "../constants";

import taskVsIssueVsBlocker from "./shared/task-vs-issue-vs-blocker.md" with { type: "text" };
import outputFormat from "./shared/output-format.md" with { type: "text" };

export type StepName =
  | "PLAN"
  | "BREAK_INTO_TASKS"
  | "REFINE_TASK_DEFINITION"
  | "RETHINK_TASK"
  | "REVIEW"
  | "RECATEGORIZE_FEEDBACK";
export type RoleName =
  | "arquitect"
  | "categorizer"
  | "implementor"
  | "reviewer"
  | "verifier"
  | "polisher"
  | "qualityReviewer"
  | "performanceReviewer"
  | "qa";
export type SharedName = "taskVsIssueVsBlocker" | "outputFormat";

// the user can override any core prompt in PROMPTS_OVERRIDES_DIR/<category>/<file>.md

async function withOverride(path: string, core: string): Promise<string> {
  const file = Bun.file(`${PROMPTS_OVERRIDES_DIR}/${path}`);
  return (await file.exists()) ? file.text() : core;
}

export const steps: Record<StepName, string> = {
  PLAN: await withOverride("steps/PLAN.md", PLAN),
  BREAK_INTO_TASKS: await withOverride("steps/BREAK_INTO_TASKS.md", BREAK_INTO_TASKS),
  REFINE_TASK_DEFINITION: await withOverride("steps/REFINE_TASK_DEFINITION.md", REFINE_TASK_DEFINITION),
  RETHINK_TASK: await withOverride("steps/RETHINK_TASK.md", RETHINK_TASK),
  REVIEW: await withOverride("steps/REVIEW.md", REVIEW),
  RECATEGORIZE_FEEDBACK: await withOverride("steps/RECATEGORIZE_FEEDBACK.md", RECATEGORIZE_FEEDBACK),
};

export const roles: Record<RoleName, string> = {
  arquitect: await withOverride("roles/arquitect.md", arquitect),
  categorizer: await withOverride("roles/categorizer.md", categorizer),
  implementor: await withOverride("roles/implementor.md", implementor),
  reviewer: await withOverride("roles/reviewer.md", reviewer),
  verifier: await withOverride("roles/verifier.md", verifier),
  polisher: await withOverride("roles/polisher.md", polisher),
  qualityReviewer: await withOverride("roles/quality-reviewer.md", qualityReviewer),
  performanceReviewer: await withOverride("roles/performance-reviewer.md", performanceReviewer),
  qa: await withOverride("roles/qa.md", qa),
};

export const shared: Record<SharedName, string> = {
  taskVsIssueVsBlocker: await withOverride("shared/task-vs-issue-vs-blocker.md", taskVsIssueVsBlocker),
  outputFormat: await withOverride("shared/output-format.md", outputFormat),
};

