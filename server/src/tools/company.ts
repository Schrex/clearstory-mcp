import type { ToolContext } from "../tools.js";
import { pick, reply, type Rec } from "../util.js";

export function registerCompanyTools({ server, cs }: ToolContext) {
  server.tool(
    "get_company",
    "Connection check: returns Schreiber's Clearstory company (id and name). Use it to confirm the Clearstory API credentials work.",
    {},
    async () => reply(pick(await cs.get<Rec>("/company"), ["id", "name"])),
  );
}
