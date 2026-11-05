import type { Domain, Domains } from "../modules/domain";
import type { Intent } from "../modules/spec";

import { roles, shared } from "./library";

// the system prompt of each agent: its role plus the context it needs
export class Rules {
  constructor(private domains: Domains) {}

  public arquitect(): string {
    return join(roles.arquitect, shared.taskVsIssueVsBlocker);
  }

  public categorizer(): string {
    return join(roles.categorizer, shared.taskVsIssueVsBlocker);
  }

  public async implementor(domain: Domain): Promise<string> {
    return join(roles.implementor, section(`AGENTS.md of ${domain}`, await this.domains.getAgentsMd(domain)));
  }

  public async reviewer(domain: Domain): Promise<string> {
    return join(roles.reviewer, section(`AGENTS.md of ${domain}`, await this.domains.getAgentsMd(domain)));
  }

  public verifier(intent: Intent, acceptance: string[]): string {
    return join(
      roles.verifier,
      section("intent", JSON.stringify(intent, null, 2)),
      section("acceptance", acceptance.map((item) => `- ${item}`).join("\n")),
    );
  }

  public finalReviewer(): string {
    return roles.reviewer;
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function join(...parts: string[]): string {
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}
