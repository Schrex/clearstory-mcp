// Sign-in shell (copied from HeavyJob): sign-in page refusals and per-request identity checks on /mcp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthorize } from "../src/auth.ts";
import { createMcpHandler } from "../src/mcp.ts";
import type { Env } from "../src/config.ts";
import { fakeFetch, fakeKv } from "./harness.ts";
import { company } from "./fixtures.ts";

const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";

async function pbkdf2Hash(password: string, iterations = 10_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

async function makeEnv(over: Partial<Env> = {}) {
  const completed: { props: unknown }[] = [];
  const provider = {
    parseAuthRequest: async () => ({ scope: ["clearstory.read"] }),
    describeConsent: async () => ({ clientName: "Claude", redirectHost: "claude.ai", redirectIsLoopback: false }),
    beginConsent: async () => ({ handle: "h1", headers: new Headers() }),
    denyConsent: async () => ({ headers: new Headers({ Location: "https://claude.ai/denied" }) }),
    approveConsent: async (request: Request) => ({ request: { scope: ["clearstory.read"] }, headers: new Headers(), original: request }),
    completeAuthorization: async (o: { props: unknown }) => { completed.push(o); return { redirectTo: "https://claude.ai/callback?code=x" }; },
  };
  const env = {
    CLEARSTORY_CLIENT_ID: "test-client-id",
    CLEARSTORY_CLIENT_SECRET: "test-client-secret",
    ALLOWED_USER_EMAIL: EMAIL,
    ACCESS_PASSWORD_HASH: await pbkdf2Hash(PASSWORD),
    TOKEN_EPOCH: "epoch-1",
    ALLOWED_CIDRS: "160.79.104.0/21",
    OAUTH_KV: fakeKv().kv,
    OAUTH_PROVIDER: provider,
    ...over,
  } as unknown as Env;
  return { env, completed };
}

const signIn = (env: Env, email: string, password: string, ip = "203.0.113.9") =>
  handleAuthorize(new Request("https://mcp.example/authorize?client_id=c", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body: new URLSearchParams({ handle: "h1", decision: "approve", email, password }),
  }), env);

test("sign-in with the allowlisted email and right password completes authorization with the token epoch", async () => {
  const { env, completed } = await makeEnv();
  const res = await signIn(env, " Owner@Example.com ", PASSWORD);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://claude.ai/callback?code=x");
  assert.deepEqual(completed[0].props, { email: EMAIL, epoch: "epoch-1" });
});

test("sign-in refuses an email that is not on the allowlist", async () => {
  const { env, completed } = await makeEnv();
  const res = await signIn(env, "someone@else.com", PASSWORD);
  assert.equal(res.status, 401);
  assert.equal(completed.length, 0);
});

test("sign-in refuses a wrong password", async () => {
  const { env, completed } = await makeEnv();
  const res = await signIn(env, EMAIL, "wrong password");
  assert.equal(res.status, 401);
  assert.equal(completed.length, 0);
});

test("sign-in locks an IP out after 5 failures, even with the right password", async () => {
  const { env, completed } = await makeEnv();
  for (let i = 0; i < 5; i++) await signIn(env, EMAIL, "nope");
  const res = await signIn(env, EMAIL, PASSWORD);
  assert.equal(res.status, 429);
  assert.equal(completed.length, 0);
});

// ---- /mcp: identity re-checked on every request ----
const ANTHROPIC_IP = "160.79.104.10";
const toolCall = (ip = ANTHROPIC_IP) => new Request("https://mcp.example/mcp", {
  method: "POST",
  headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_company", arguments: {} } }),
});
const ctx = (props: unknown) => ({ props, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

test("/mcp serves a tool call for a current, allowlisted session", async () => {
  const { env } = await makeEnv();
  const { fetch } = fakeFetch({ "GET /company": company });
  const res = await createMcpHandler({ fetch }).fetch(toolCall(), env, ctx({ email: EMAIL, epoch: "epoch-1" }));
  assert.equal(res.status, 200);
  const body = await res.json() as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(body.result.content[0].text), { id: 4821, name: "Schreiber Excavating, Inc." });
});

test("changing TOKEN_EPOCH revokes existing sessions", async () => {
  const { env } = await makeEnv({ TOKEN_EPOCH: "epoch-2" });
  const { fetch, calls } = fakeFetch({ "GET /company": company });
  const res = await createMcpHandler({ fetch }).fetch(toolCall(), env, ctx({ email: EMAIL, epoch: "epoch-1" }));
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /invalid_token/);
  assert.equal(calls.length, 0);
});

test("removing the email from the allowlist refuses its sessions", async () => {
  const { env } = await makeEnv({ ALLOWED_USER_EMAIL: "new@example.com" });
  const { fetch, calls } = fakeFetch({ "GET /company": company });
  const res = await createMcpHandler({ fetch }).fetch(toolCall(), env, ctx({ email: EMAIL, epoch: "epoch-1" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("/mcp refuses callers outside the IP allowlist", async () => {
  const { env } = await makeEnv();
  const { fetch, calls } = fakeFetch({ "GET /company": company });
  const res = await createMcpHandler({ fetch }).fetch(toolCall("198.51.100.1"), env, ctx({ email: EMAIL, epoch: "epoch-1" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});
