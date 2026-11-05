import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// writes `files` (path → contents) into a new temporary directory and returns it
export async function fixture(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "plain-test-"));
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(join(dir, path), contents);
  }
  return dir;
}

// a service shaped like spec.example.yaml expects
export const SERVICE: Record<string, string> = {
  "src/gateways/billing/AGENTS.md": "# billing",
  "src/gateways/billing/hooks/legacy.ts": "export function useLegacyInvoiceLink() {}",
  "src/gateways/billing/index.ts": 'export { useLegacyInvoiceLink } from "./hooks/legacy";',
  "src/gateways/crm/AGENTS.md": "# crm",
  "src/gateways/crm/index.ts": "export type Customer = { id: string; email: string; name: string };",
  "src/features/invoice-list/AGENTS.md": "# invoice list",
  "src/features/invoice-list/InvoiceList.tsx":
    "export function InvoiceList() { return null; }\nInvoiceList.Row = function Row() { return null; };",
  "src/lib/pdf/AGENTS.md": "# pdf",
  "src/lib/pdf/sub/AGENTS.md": "# a submodule",
  "src/lib/pdf/sub/merge.ts": "export function mergePdfs() {}",
  "node_modules/@acme/contracts/index.d.ts": "export type User = { id: string };",
};
