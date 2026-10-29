import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClearstoryClient } from "./clearstory.js";
import type { Config } from "./config.js";
import { registerSummaryTools } from "./tools/summary.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerTagTools } from "./tools/tags.js";
import { registerCorTools } from "./tools/cors.js";
import { registerDraftCorTools } from "./tools/draft-cor.js";

/** Who is calling (from the OAuth props) and the Worker's KV. */
export interface Session { email: string; kv: KVNamespace; now?: () => Date }

/** What each tool module gets. Add a module under src/tools/ and list its register function below. */
export interface ToolContext { server: McpServer; cs: ClearstoryClient; cfg: Config; session: Session }

const MODULES: ((t: ToolContext) => void)[] = [
  registerCompanyTools,
  registerJobTools,
  registerReferenceTools,
  registerNotificationTools,
  registerTagTools,
  registerCorTools,
  registerDraftCorTools,
  registerSummaryTools,
];

/** All tools are read-only except create_draft_cor: every Clearstory call goes through ClearstoryClient's guard (GET, plus only POST /cors; ADR 0003). */
export function buildServer(cfg: Config, cs: ClearstoryClient, session: Session): McpServer {
  const server = new McpServer({ name: "schrex-clearstory-mcp", version: "0.1.0" });
  for (const register of MODULES) register({ server, cs, cfg, session });
  return server;
}
