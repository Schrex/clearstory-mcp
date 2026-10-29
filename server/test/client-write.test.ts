// The one Clearstory write (ADR 0003): ClearstoryClient.createDraftCor sends POST /cors and reports
// created / refused / outcome unknown. These harnesses use `writes: true`, so this file asserts its own
// requests; every other test file stays under the suite-wide GET-only check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, json, tokenResponse } from "./harness.ts";
import { ReadOnlyError, WriteOutcomeUnknownError, WriteRefusedError } from "../src/clearstory.ts";
import { corDetail } from "./fixtures-cors.ts";

const DRAFT = { projectId: 7001, title: "Extra 150 LF 12in storm", description: "Bid items 2575, 2555", amount: 18450.45 };
const created = () => json(corDetail({ id: 6301, corNumber: "COR-018", status: "placeholder", stage: "draft", requestedAmount: 18450.45, contractId: 9001 }), 201);

test("createDraftCor sends one POST /cors with the JSON body and returns the created COR", async () => {
  const h = await harness({ "POST /cors": created }, { writes: true });
  const cor = await h.cs.createDraftCor(DRAFT);
  assert.equal(cor.id, 6301);
  assert.equal(cor.corNumber, "COR-018");
  assert.equal(cor.requestedAmount, 18450.45);
  assert.equal(h.apiCalls().length, 1);
  const [call] = h.apiCalls();
  assert.equal(call.method, "POST");
  assert.equal(call.url, h.cfg.apiBase + "/cors");
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers.authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(call.body!), DRAFT);
});

const refusedWrites: [string, string, Record<string, string>][] = [
  ["POST", "/cors", { x: "1" }], ["POST", "/tags", {}], ["PATCH", "/cors/1", {}], ["DELETE", "/tags/1", {}], ["PUT", "/cors/1", {}],
  ["POST", "/cors/", {}], ["POST", "/cors?x=1", {}], ["post", "/cors/1/labels", {}],
];
for (const [method, path, query] of refusedWrites) {
  test(`${method} ${path}${Object.keys(query).length ? " with a query" : ""} is refused with no network request`, async () => {
    const h = await harness({ [`${method.toUpperCase()} ${path}`]: {} }, { writes: true });
    await assert.rejects(h.cs.request(method, path, query, DRAFT), ReadOnlyError);
    assert.equal(h.calls.length, 0, "no request sent (not even a token POST)");
  });
}

test("a POST /cors without a body is refused with no network request", async () => {
  const h = await harness({ "POST /cors": created }, { writes: true });
  await assert.rejects(h.cs.request("POST", "/cors"), ReadOnlyError);
  assert.equal(h.calls.length, 0);
});

const unknowns: [string, () => Response | Promise<Response>][] = [
  ["500", () => json({ success: false, message: "boom" }, 500)],
  ["502 HTML", () => new Response("<html>Bad Gateway</html>", { status: 502 })],
  ["503 with Retry-After", () => json({}, 503, { "Retry-After": "1" })],
  ["network error", () => Promise.reject(new TypeError("fetch failed"))],
  ["timeout", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))],
  ["2xx non-JSON body", () => new Response("<html>ok</html>", { status: 201 })],
  ["2xx empty body", () => new Response("", { status: 201 })],
  ["2xx JSON without an id", () => json({ success: true }, 201)],
];
for (const [name, answer] of unknowns) {
  test(`${name}: outcome unknown, POST sent exactly once`, async () => {
    const h = await harness({ "POST /cors": answer }, { writes: true });
    const err = await h.cs.createDraftCor(DRAFT).then(() => assert.fail("expected an error"), (e: unknown) => e);
    assert.ok(err instanceof WriteOutcomeUnknownError, String(err));
    assert.match((err as Error).message, /check Clearstory/i);
    assert.equal(h.apiCalls().filter((c) => c.method === "POST").length, 1);
  });
}

test("422 field validation is refused with Clearstory's errors passed through, whitespace collapsed", async () => {
  const h = await harness({ "POST /cors": () => new Response('{"success":false,\n  "errors":["title:   must be at most 255 characters"]}', { status: 422 }) }, { writes: true });
  const err = await h.cs.createDraftCor(DRAFT).then(() => assert.fail("expected an error"), (e: unknown) => e);
  assert.ok(err instanceof WriteRefusedError, String(err));
  assert.equal((err as WriteRefusedError).status, 422);
  assert.match((err as Error).message, /HTTP 422 - \{"success":false, "errors":\["title: must be at most 255 characters"\]\}/);
  assert.equal(h.apiCalls().length, 1);
});

test("422 business rule (unknown contract) is refused with the message, capped at 500 chars", async () => {
  const long = "unknown contract " + "x".repeat(1000);
  const h = await harness({ "POST /cors": () => json({ success: false, message: long }, 422) }, { writes: true });
  const err = await h.cs.createDraftCor(DRAFT).then(() => assert.fail("expected an error"), (e: unknown) => e);
  assert.ok(err instanceof WriteRefusedError, String(err));
  assert.match((err as Error).message, /unknown contract/);
  assert.equal((err as Error).message.split(" - ")[1].length, 500);
  assert.equal(h.apiCalls().length, 1);
});

test("401 refreshes the token once and retries the POST once", async () => {
  let n = 0;
  const tokens = ["tok-1", "tok-2"];
  const h = await harness({ "POST /cors": () => (++n === 1 ? json({ message: "expired" }, 401) : created()) },
    { writes: true, token: () => tokenResponse(tokens.shift()) });
  const cor = await h.cs.createDraftCor(DRAFT);
  assert.equal(cor.id, 6301);
  assert.equal(h.tokenPosts(), 2);
  assert.deepEqual(h.apiCalls().map((c) => c.headers.authorization), ["Bearer tok-1", "Bearer tok-2"]);
});

test("a second 401 is refused, with no third POST", async () => {
  const h = await harness({ "POST /cors": () => json({ message: "unauthorized" }, 401) }, { writes: true });
  const err = await h.cs.createDraftCor(DRAFT).then(() => assert.fail("expected an error"), (e: unknown) => e);
  assert.ok(err instanceof WriteRefusedError, String(err));
  assert.equal((err as WriteRefusedError).status, 401);
  assert.equal(h.apiCalls().length, 2);
  assert.equal(h.tokenPosts(), 2);
});

test("429 waits for Retry-After and retries", async () => {
  let n = 0;
  const waits: number[] = [];
  const h = await harness({ "POST /cors": () => (++n === 1 ? json({}, 429, { "Retry-After": "7" }) : created()) },
    { writes: true, sleep: async (ms) => { waits.push(ms); } });
  const cor = await h.cs.createDraftCor(DRAFT);
  assert.equal(cor.id, 6301);
  assert.deepEqual(waits, [7000]);
  assert.equal(h.apiCalls().length, 2);
});

test("429 on every try is refused after 4 POSTs", async () => {
  const h = await harness({ "POST /cors": () => json({}, 429, { "Retry-After": "1" }) }, { writes: true });
  const err = await h.cs.createDraftCor(DRAFT).then(() => assert.fail("expected an error"), (e: unknown) => e);
  assert.ok(err instanceof WriteRefusedError, String(err));
  assert.equal((err as WriteRefusedError).status, 429);
  assert.equal(h.apiCalls().length, 4);
});
