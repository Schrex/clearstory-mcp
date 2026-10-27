import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClearstoryClient } from "./clearstory.js";
import type { Config } from "./config.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerTagTools } from "./tools/tags.js";
import { registerCorTools } from "./tools/cors.js";

/** What each tool module gets. Add a module under src/tools/ and list its register function below. */
export interface ToolContext { server: McpServer; cs: ClearstoryClient; cfg: Config }

const MODULES: ((t: ToolContext) => void)[] = [
  registerCompanyTools,
  registerJobTools,
  registerNotificationTools,
  registerTagTools,
  registerCorTools,
];

/** All tools are read-only: every Clearstory call goes through ClearstoryClient's GET-only guard. */
export function buildServer(cfg: Config, cs: ClearstoryClient): McpServer {
  const server = new McpServer({ name: "schrex-clearstory-mcp", version: "0.1.0" });
  for (const register of MODULES) register({ server, cs, cfg });
  return server;
}
