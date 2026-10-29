// Shared test harness: the one agreed seam.
// Call an MCP tool by name (real McpServer + Client over InMemoryTransport, so zod validation and
// error wrapping are real) with Clearstory HTTP replaced by a fake fetch that serves fixtures and
// records every request. Importing this file also installs the suite-wide read-only assertion.
import { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClearstoryClient, type FetchFn } from "../src/clearstory.ts";
import type { Config } from "../src/config.ts";
import { buildServer } from "../src/tools.ts";

export const TEST_CFG: Config = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  tokenUrl: "https://auth.clearstory.build/oauth/token",
  apiBase: "https://io.clearstory.build/clearstory/v1",
  audience: "https://io.clearstory.build",
  pageSize: 100,
  maxSubrequests: 45,
  allowedCidrs: [],
  maxDraftCorAmount: 250000,
};

export interface Recorded { method: string; url: string; headers: Record<string, string>; body?: string }
export interface FakeRequest { method: string; url: URL; path: string; body?: string }
/** A route answers with a JSON-able value (served as 200) or a full Response. */
export type Route = unknown | ((req: FakeRequest) => unknown | Response | Promise<unknown | Response>);
/** Keys are "METHOD /path" relative to apiBase, e.g. "GET /company". Query strings are ignored for matching. */
export type Routes = Record<string, Route>;

/** Every request any harness made in this test file (checked by the suite-wide assertion below). */
export const allRequests: Recorded[] = [];

export function fakeKv() {
  const store = new Map<string, string>();
  const puts: { key: string; value: string; opts?: unknown }[] = [];
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: unknown) => { store.set(k, v); puts.push({ key: k, value: v, opts }); },
    delete: async (k: string) => { store.delete(k); },
  };
  return { kv: kv as unknown as KVNamespace, store, puts };
}

export type FakeKv = ReturnType<typeof fakeKv>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export const tokenResponse = (token = "tok-1", expiresIn = 86400) =>
  json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });

/** Fake fetch: token POST answered by `token` (default: a fresh 24 h token), API paths by `routes`, else 404. */
/** `global: false` keeps the requests out of `allRequests` (write tests assert their own requests). */
export function fakeFetch(routes: Routes, cfg: Config = TEST_CFG, token: () => Response = () => tokenResponse(), global = true) {
  const calls: Recorded[] = [];
  const fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const rec = { method, url: url.toString(), headers, body };
    calls.push(rec);
    if (global) allRequests.push(rec);
    if (url.toString() === cfg.tokenUrl) return token();
    const path = url.pathname.startsWith(new URL(cfg.apiBase).pathname)
      ? url.pathname.slice(new URL(cfg.apiBase).pathname.length) : url.pathname;
    const route = routes[`${method} ${path}`];
    if (route === undefined) return json({ message: `No fixture for ${method} ${path}` }, 404);
    const out = typeof route === "function" ? await (route as (r: FakeRequest) => unknown)({ method, url, path, body }) : route;
    return out instanceof Response ? out : json(out);
  };
  return { fetch, calls };
}

export interface HarnessOpts {
  cfg?: Partial<Config>;
  /** Share a KV between harnesses to simulate a cold isolate reading a cached token. */
  kv?: FakeKv;
  token?: () => Response;
  sleep?: (ms: number) => Promise<void>;
  /** Draft-COR write tests (ADR 0003): keep this harness's requests out of the suite-wide read-only check. */
  writes?: boolean;
  /** Signed-in email (OAuth props). Default tester@schrex.com. */
  email?: string;
  /** Clock for tools (e.g. the draft COR footer date). */
  now?: () => Date;
}

export async function harness(routes: Routes = {}, opts: HarnessOpts = {}) {
  const cfg = { ...TEST_CFG, ...opts.cfg };
  const kv = opts.kv ?? fakeKv();
  const { fetch, calls } = fakeFetch(routes, cfg, opts.token, !opts.writes);
  const cs = new ClearstoryClient(cfg, kv.kv, { fetch, sleep: opts.sleep ?? (async () => {}) });
  const server = buildServer(cfg, cs, { email: opts.email ?? "tester@schrex.com", kv: kv.kv, now: opts.now });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  /** Call a tool by name. `json` is the parsed reply (undefined on error); `text` is the raw text. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content[0]?.text ?? "";
    return { isError: !!r.isError, text, json: r.isError ? undefined : JSON.parse(text) };
  };
  const tokenPosts = () => calls.filter((c) => c.method === "POST" && c.url === cfg.tokenUrl).length;
  const apiCalls = () => calls.filter((c) => c.url !== cfg.tokenUrl);
  return { call, calls, apiCalls, tokenPosts, kv, cs, client, cfg };
}

// ---- suite-wide read-only assertion (ADR 0001) ----
// Runs after every test file that imports the harness: across the whole file, the fake Clearstory
// saw only GETs to the API and POSTs to the token URL, each with a non-blank User-Agent.
export function assertReadOnly(requests: Recorded[], cfg: Config = TEST_CFG) {
  for (const r of requests) {
    if (r.url === cfg.tokenUrl) assert.equal(r.method, "POST", `token URL called with ${r.method}`);
    else {
      assert.equal(r.method, "GET", `non-GET ${r.method} ${r.url} reached the network`);
      assert.ok(r.url.startsWith(cfg.apiBase + "/"), `request outside the API base: ${r.url}`);
    }
    assert.ok((r.headers["user-agent"] ?? "").trim(), `blank User-Agent on ${r.method} ${r.url}`);
  }
}
after(() => assertReadOnly(allRequests));
