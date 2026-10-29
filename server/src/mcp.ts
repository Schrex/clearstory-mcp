import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ClearstoryClient, type ClientDeps } from "./clearstory.js";
import { loadConfig, type Env } from "./config.js";
import { buildServer } from "./tools.js";
import { ipAllowed } from "./ip.js";
import { emailAllowed, type AuthProps } from "./auth.js";

const unauthorized = (why: string) => new Response(JSON.stringify({ error: "invalid_token", error_description: why }), {
  status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer error="invalid_token", error_description="${why}"` },
});

/** /mcp: reached only with a valid OAuth access token (the library validates it and sets ctx.props). `deps` lets tests inject fetch. */
export function createMcpHandler(deps: ClientDeps = {}) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      let cfg;
      try { cfg = loadConfig(env); } catch (e) { console.error((e as Error).message); return new Response("misconfigured", { status: 500 }); }
      const ip = request.headers.get("CF-Connecting-IP") ?? "";
      if (!ipAllowed(ip, cfg.allowedCidrs)) return new Response(null, { status: 403 });
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

      // Identity check on EVERY request (so every tool call): token epoch current and email still allowlisted.
      const props = (ctx as unknown as { props?: AuthProps }).props;
      if (!props?.email || props.epoch !== env.TOKEN_EPOCH) return unauthorized("Token revoked; sign in again.");
      if (!(await emailAllowed(env, props.email))) { console.warn(JSON.stringify({ evt: "mcp_denied", email: props.email })); return new Response(null, { status: 403 }); }

      // Audit log: email + tool name only, never arguments or data.
      try {
        const body = await request.clone().json() as unknown;
        for (const m of Array.isArray(body) ? body : [body]) {
          const msg = m as { method?: string; params?: { name?: string } };
          if (msg?.method === "tools/call") console.log(JSON.stringify({ evt: "tool_call", email: props.email, tool: msg.params?.name }));
        }
      } catch { /* not JSON: the transport will reject it */ }

      // Fresh client per request: per-invocation subrequest budget and state.
      const cs = new ClearstoryClient(cfg, env.OAUTH_KV, deps);
      const server = buildServer(cfg, cs, { email: props.email, kv: env.OAUTH_KV });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } catch (e) {
        console.error("mcp error", (e as Error).message);
        return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
      }
    },
  };
}
