export interface Env {
  // secrets (wrangler secret put; values never committed)
  CLEARSTORY_CLIENT_ID: string;
  CLEARSTORY_CLIENT_SECRET: string;
  ALLOWED_USER_EMAIL: string;        // comma-separated allowlist
  ACCESS_PASSWORD_HASH: string;      // pbkdf2$<iter>$<salt_b64>$<hash_b64>
  TOKEN_EPOCH: string;               // rotate to revoke every issued token
  // vars (wrangler.toml)
  CLEARSTORY_TOKEN_URL?: string;
  CLEARSTORY_API_BASE?: string;
  CLEARSTORY_PAGE_SIZE?: string;
  CLEARSTORY_MAX_SUBREQUESTS?: string;
  ALLOWED_CIDRS?: string;
  PUBLIC_ORIGIN?: string;
  MAX_DRAFT_COR_AMOUNT?: string;     // cap per draft COR (default 250000)            // e.g. https://schrex-clearstory-mcp.schrex.workers.dev
  OAUTH_KV: KVNamespace;             // OAuth library state + login throttle + cached Clearstory token
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers; // injected by the library
}

export interface Config {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  apiBase: string;
  audience: string;
  pageSize: number;        // Clearstory limit, 1-100
  maxSubrequests: number;  // Workers free plan: 50 per invocation
  allowedCidrs: string[];
  maxDraftCorAmount: number; // largest amount preview_draft_cor accepts
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Env): Config {
  if (!env.CLEARSTORY_CLIENT_ID || !env.CLEARSTORY_CLIENT_SECRET) throw new Error("CLEARSTORY_CLIENT_ID / CLEARSTORY_CLIENT_SECRET secrets are not set.");
  return {
    clientId: env.CLEARSTORY_CLIENT_ID,
    clientSecret: env.CLEARSTORY_CLIENT_SECRET,
    tokenUrl: env.CLEARSTORY_TOKEN_URL || "https://auth.clearstory.build/oauth/token",
    apiBase: (env.CLEARSTORY_API_BASE || "https://io.clearstory.build/clearstory/v1").replace(/\/$/, ""),
    audience: "https://io.clearstory.build", // must match exactly
    pageSize: Math.min(100, Math.max(1, num(env.CLEARSTORY_PAGE_SIZE, 100))),
    maxSubrequests: Math.min(48, num(env.CLEARSTORY_MAX_SUBREQUESTS, 45)),
    maxDraftCorAmount: num(env.MAX_DRAFT_COR_AMOUNT, 250_000),
    allowedCidrs: (env.ALLOWED_CIDRS ?? "160.79.104.0/21").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export const allowedEmails = (env: Pick<Env, "ALLOWED_USER_EMAIL">) =>
  (env.ALLOWED_USER_EMAIL ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
