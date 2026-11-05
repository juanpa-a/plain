import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// a directory of the repo with its own AGENTS.md
export type Domain = string;

export class Domains {
  constructor(private service: string) {}

  // the AGENTS.md of the domain, or of its closest parent when the domain is new
  public async getAgentsMd(domain: Domain): Promise<string> {
    const root = resolve(this.service);
    let dir = resolve(root, domain);

    while (true) {
      const path = join(dir, "AGENTS.md");
      if (existsSync(path)) return Bun.file(path).text();
      if (dir === root || dir === dirname(dir)) return "";
      dir = dirname(dir);
    }
  }

  public exists(domain: Domain): boolean {
    return existsSync(resolve(this.service, domain));
  }
}
