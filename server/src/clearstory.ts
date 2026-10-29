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

/** Thrown for any non-GET API call other than the draft-COR create, before anything is sent (ADR 0001, ADR 0003). */
export class ReadOnlyError extends Error {}
/** Clearstory answered a write and did not apply it (4xx, after the 401 refresh and 429 waits). Nothing was created. */
export class WriteRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
/**
 * A write may have reached Clearstory but we have no answer (5xx, network error, timeout, unreadable 2xx).
 * Never retried (POST /cors has no idempotency key): the caller must tell the user to check Clearstory.
 */
export class WriteOutcomeUnknownError extends Error {}
/** Thrown when this invocation's subrequest budget (Workers free plan) is spent. Pagers turn it into scope: partial. */
export class BudgetError extends Error {}

const MAX_TRIES = 4;
const MAX_WAIT_MS = 30_000;
const WRITE_TIMEOUT_MS = 30_000;
/** The only writes this client sends: "METHOD /path", exact path, no query string (ADR 0003). */
const ALLOWED_WRITES = new Set(["POST /cors"]);

/** Clearstory CreateCORRequest. title 1-255 chars; the contract can't be chosen (Clearstory picks it). */
export interface DraftCorInput { projectId: number; title: string; description?: string; amount?: number }
/** The parts of Clearstory's CORDetail (201 from POST /cors) callers rely on. */
export interface CreatedCor {
  id: number; corNumber?: string; status?: string; stage?: string; requestedAmount?: number; contractId?: number;
  [k: string]: unknown;
}

type TokenEntry = { token: string; exp: number };

/**
 * Read-only Clearstory client, plus one write: creating a draft COR (ADR 0003).
 * Create one per Worker invocation: state (token, subrequest count) is per instance.
 * Clearstory credentials have no scopes, so the method/path allowlist here is the only write protection.
 * Besides the token POST, POST /cors is the single non-GET request this client ever sends.
 */
export class ClearstoryClient {
  private readonly cfg: Config;
  private readonly kv: KVNamespace;
  private readonly fetchFn: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;
  private token?: TokenEntry;
  /** Subrequests (token POST + every GET attempt) sent by this instance. */
  used = 0;

  /** Clearstory page size for list endpoints (1-100). */
  get pageSize() { return this.cfg.pageSize; }

  /** Count one subrequest against the budget; throws BudgetError (before sending) once it is spent. */
  private spend() {
    if (this.used >= this.cfg.maxSubrequests) throw new BudgetError(`Clearstory request limit (${this.cfg.maxSubrequests} per call) reached.`);
    this.used++;
  }

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

  /**
   * Create a draft COR: one POST /cors. Returns the created COR; throws WriteRefusedError (not created),
   * WriteOutcomeUnknownError (may exist: check Clearstory), or a plain Error before anything was sent.
   */
  createDraftCor(input: DraftCorInput): Promise<CreatedCor> {
    return this.request<CreatedCor>("POST", "/cors", {}, input);
  }

  /** Every API call goes through here. Any method other than GET throws before a network call, unless allowlisted. */
  async request<T = unknown>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const m = method.toUpperCase();
    if (m !== "GET") {
      const hasQuery = Object.values(query).some((v) => v !== undefined && v !== "");
      if (!ALLOWED_WRITES.has(`${m} ${path}`) || hasQuery || body === undefined) throw new ReadOnlyError(`Clearstory connector is read-only: ${method} ${path} refused.`);
      return this.write<T>(m, path, body);
    }
    const url = this.url(path, query);
    const res = await this.send(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`Clearstory GET ${path} failed: HTTP ${res.status} - ${text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new Error(`Clearstory returned non-JSON for GET ${path} (HTTP ${res.status})`); }
  }

  /** An allowlisted write. Sorts every answer into created (returned), refused, or outcome unknown. */
  private async write<T>(method: string, path: string, body: unknown): Promise<T> {
    const res = await this.send(this.url(path, {}), { method, body: JSON.stringify(body) });
    let text: string;
    try { text = await res.text(); } catch { throw new WriteOutcomeUnknownError(`Clearstory ${method} ${path}: HTTP ${res.status} but the answer could not be read. Check Clearstory before trying again.`); }
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (res.status >= 500) throw new WriteOutcomeUnknownError(`Clearstory ${method} ${path}: HTTP ${res.status}, outcome unknown. Check Clearstory before trying again. ${detail}`.trim());
    if (!res.ok) throw new WriteRefusedError(`Clearstory refused ${method} ${path}: HTTP ${res.status} - ${detail}`, res.status);
    let out: unknown;
    try { out = JSON.parse(text); } catch { /* handled below */ }
    if (!out || typeof out !== "object" || typeof (out as { id?: unknown }).id !== "number") {
      throw new WriteOutcomeUnknownError(`Clearstory ${method} ${path}: HTTP ${res.status} with an unreadable body, outcome unknown. Check Clearstory before trying again.`);
    }
    return out as T;
  }

  /**
   * Request with the bearer token, up to 4 tries: a 401 drops the cached token and retries once with a new one;
   * 429 (and 5xx, GET only) wait for Retry-After (else 1 s, 2 s, 4 s; capped at 30 s). Every attempt counts against the budget.
   * A write is never retried once it may have been processed: 5xx, network errors and timeouts throw WriteOutcomeUnknownError.
   */
  protected async send(url: string, write?: { method: string; body: string }): Promise<Response> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      this.spend();
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json", Authorization: `Bearer ${token}` };
      let res: Response;
      if (!write) res = await this.fetchFn(url, { method: "GET", headers });
      else {
        try {
          res = await this.fetchFn(url, { method: write.method, headers: { ...headers, "Content-Type": "application/json" }, body: write.body, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
        } catch (e) {
          throw new WriteOutcomeUnknownError(`Clearstory ${write.method} ${new URL(url).pathname}: no answer (${(e as Error)?.name ?? "error"}), outcome unknown. Check Clearstory before trying again.`);
        }
      }
      if (attempt >= MAX_TRIES) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.token = undefined;
        await this.kv.delete(TOKEN_KV_KEY);
        continue;
      }
      if (res.status !== 429 && (write || res.status < 500)) return res;
      const after = Number(res.headers.get("Retry-After"));
      await this.sleep(Math.min(MAX_WAIT_MS, res.headers.has("Retry-After") && Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** (attempt - 1)));
    }
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
    this.spend();
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
