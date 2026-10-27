import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeKv, harness, TEST_CFG } from "./harness.ts";
import { company } from "./fixtures.ts";

test("token is fetched once and reused across tool calls", async () => {
  const h = await harness({ "GET /company": company });
  await h.call("get_company");
  await h.call("get_company");
  await h.call("get_company");
  assert.equal(h.tokenPosts(), 1);
  assert.equal(h.apiCalls().length, 3);
  for (const c of h.apiCalls()) assert.equal(c.headers.authorization, "Bearer tok-1");
});

test("token request uses client credentials with the exact Clearstory audience", async () => {
  const h = await harness({ "GET /company": company });
  await h.call("get_company");
  const post = h.calls.find((c) => c.url === TEST_CFG.tokenUrl)!;
  const form = new URLSearchParams(post.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("client_id"), "test-client-id");
  assert.equal(form.get("client_secret"), "test-client-secret");
  assert.equal(form.get("audience"), "https://io.clearstory.build");
});

test("token is cached in KV with a TTL under its 24 h life", async () => {
  const kv = fakeKv();
  const h = await harness({ "GET /company": company }, { kv });
  await h.call("get_company");
  const put = kv.puts.find((p) => p.key === "cs:token")!;
  assert.ok(put, "token written to KV");
  const ttl = (put.opts as { expirationTtl: number }).expirationTtl;
  assert.ok(ttl >= 60 && ttl < 86400, `ttl ${ttl}`);
});

test("a cold isolate reads the token from KV instead of the token URL", async () => {
  const kv = fakeKv();
  const warm = await harness({ "GET /company": company }, { kv });
  await warm.call("get_company");
  const cold = await harness({ "GET /company": company }, { kv });
  const r = await cold.call("get_company");
  assert.equal(r.isError, false, r.text);
  assert.equal(cold.tokenPosts(), 0);
  assert.equal(cold.apiCalls()[0].headers.authorization, "Bearer tok-1");
});

test("an expired KV token is replaced", async () => {
  const kv = fakeKv();
  kv.store.set("cs:token", JSON.stringify({ token: "old", exp: Date.now() - 1000 }));
  const h = await harness({ "GET /company": company }, { kv });
  await h.call("get_company");
  assert.equal(h.tokenPosts(), 1);
  assert.equal(h.apiCalls()[0].headers.authorization, "Bearer tok-1");
});

for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
  test(`client refuses ${method} to the API without any network request`, async () => {
    const h = await harness({ [`${method.toUpperCase()} /cors`]: {} });
    await assert.rejects(h.cs.request(method, "/cors"), /read-only/);
    assert.equal(h.calls.length, 0, "no request sent (not even a token POST)");
  });
}

test("every request carries a non-blank User-Agent", async () => {
  const h = await harness({ "GET /company": company });
  await h.call("get_company");
  assert.ok(h.calls.length >= 2);
  for (const c of h.calls) assert.ok(c.headers["user-agent"]?.trim(), `${c.method} ${c.url}`);
});

test("a failed token request is a tool error that does not echo the secret", async () => {
  const h = await harness({ "GET /company": company }, { token: () => new Response("{\"error\":\"access_denied\"}", { status: 401 }) });
  const r = await h.call("get_company");
  assert.equal(r.isError, true);
  assert.match(r.text, /token request failed: HTTP 401/);
  assert.doesNotMatch(r.text, /test-client-secret/);
  assert.equal(h.apiCalls().length, 0);
});
