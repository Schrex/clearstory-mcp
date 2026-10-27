import type { Config } from "./config.js";

export type Query = Record<string, string | number | boolean | undefined>;
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export interface ClientDeps {
  fetch?: FetchFn;
  /** Injected so retry/backoff tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/** Clearstory rejects a blank User-Agent with 400; always send this one. */
export const USER_AGENT = "Mozilla/5.0 SchreiberMCP/0.1";
const TOKEN_KV_KEY = "cs:token";
const TOKEN_SKEW_MS = 5 * 60_000; // treat the token as expired 5 min early

/** Thrown for any non-GET API call, before anything is sent (ADR 0001). */
export class ReadOnlyError extends Error {}

type TokenEntry = { token: string; exp: number };

/**
 * Read-only Clearstory client. Create one per Worker invocation: state (token, subrequest count) is per instance.
 * Clearstory credentials have no scopes, so the GET-only guard here is the only write protection.
 * The token POST is the single non-GET request this client ever sends.
 */
export class ClearstoryClient {
  private readonly cfg: Config;
  private readonly kv: KVNamespace;
  private readonly fetchFn: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;
  private token?: TokenEntry;

  constructor(cfg: Config, kv: KVNamespace, deps: ClientDeps = {}) {
    this.cfg = cfg;
    this.kv = kv;
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET a path under the API base (e.g. "/company") and return parsed JSON. */
  get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  /** Every API call goes through here. Any method other than GET throws before a network call. */
  async request<T = unknown>(method: string, path: string, query: Query = {}): Promise<T> {
    if (method.toUpperCase() !== "GET") throw new ReadOnlyError(`Clearstory connector is read-only: ${method} ${path} refused.`);
    const url = this.url(path, query);
    const res = await this.send(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`Clearstory GET ${path} failed: HTTP ${res.status} - ${text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new Error(`Clearstory returned non-JSON for GET ${path} (HTTP ${res.status})`); }
  }

  /** One GET attempt with the bearer token. Seam for retry/backoff and budget (ticket #2). */
  protected async send(url: string): Promise<Response> {
    const token = await this.accessToken();
    return this.fetchFn(url, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/json", Authorization: `Bearer ${token}` } });
  }

  private url(path: string, query: Query): string {
    const u = new URL(this.cfg.apiBase + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Client-credentials token: instance memory, then KV (shared across isolates), then the token URL. */
  async accessToken(): Promise<string> {
    const fresh = (e?: TokenEntry) => !!e && Date.now() < e.exp - TOKEN_SKEW_MS;
    if (fresh(this.token)) return this.token!.token;
    try {
      const cached = await this.kv.get(TOKEN_KV_KEY);
      const e = cached ? (JSON.parse(cached) as TokenEntry) : undefined;
      if (fresh(e)) { this.token = e; return e!.token; }
    } catch { /* bad KV entry: fetch a new token */ }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      audience: this.cfg.audience,
    });
    const res = await this.fetchFn(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Clearstory token request failed: HTTP ${res.status}`); // never echo secrets
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("Clearstory token response had no access_token.");
    const ttl = j.expires_in ?? 86400;
    this.token = { token: j.access_token, exp: Date.now() + ttl * 1000 };
    await this.kv.put(TOKEN_KV_KEY, JSON.stringify(this.token), { expirationTtl: Math.max(60, ttl - 300) });
    return this.token.token;
  }
}
