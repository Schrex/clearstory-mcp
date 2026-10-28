import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./config.js";
import { emailAllowed, handleAuthorize, type AuthProps } from "./auth.js";
import { createMcpHandler } from "./mcp.js";

const ACCESS_TTL_S = 60 * 60;            // 1 h access tokens
const REFRESH_TTL_S = 365 * 24 * 60 * 60; // grant (refresh) lives 1 year from sign-in, then sign in again; rotate TOKEN_EPOCH to revoke sooner

const mcpHandler = createMcpHandler();

/** Everything that is not /mcp or an OAuth protocol endpoint. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    return new Response(null, { status: 404 });
  },
};

// The provider needs the canonical resource URL, which comes from env, so build it on first request (per isolate).
let provider: OAuthProvider<Env> | undefined;
let providerOrigin = "";
function getProvider(origin: string): OAuthProvider<Env> {
  if (provider && providerOrigin === origin) return provider;
  providerOrigin = origin;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register", // dynamic client registration (Claude uses DCR)
    scopesSupported: ["clearstory.read"],
    requiredScopes: ["clearstory.read"],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Schreiber Clearstory (read-only)" },
    accessTokenTTL: ACCESS_TTL_S,
    refreshTokenTTL: REFRESH_TTL_S,
    // On every refresh: refuse if TOKEN_EPOCH was rotated or the email was removed from the allowlist.
    tokenExchangeCallback: async (o) => {
      const p = o.props as AuthProps | undefined;
      const env = o.env;
      if (!p?.email || p.epoch !== env.TOKEN_EPOCH || !(await emailAllowed(env, p.email))) {
        throw new OAuthError("invalid_grant", { description: "Access was revoked. Sign in again." });
      }
    },
  });
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    if (!env.TOKEN_EPOCH || !env.ACCESS_PASSWORD_HASH || !env.ALLOWED_USER_EMAIL) {
      console.error("TOKEN_EPOCH / ACCESS_PASSWORD_HASH / ALLOWED_USER_EMAIL secrets are not set.");
      return new Response("misconfigured", { status: 500 });
    }
    const origin = (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "").toLowerCase();
    return getProvider(origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
