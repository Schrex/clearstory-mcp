// Shared list behaviour (paging, budget, retry, error passthrough), exercised through search_jobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, json, type FakeRequest } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";

/** A /projects that serves `total` Jobs honouring limit/offset like Clearstory. */
const jobsOf = (total: number, firstId = 100) => (req: FakeRequest) => {
  const limit = Number(req.url.searchParams.get("limit"));
  const offset = Number(req.url.searchParams.get("offset"));
  assert.ok(limit >= 1 && limit <= 100, `limit ${limit} outside 1-100`);
  const all = Array.from({ length: total }, (_, i) => projectRecord({ id: firstId + i, jobNumber: String(30000 + i) }));
  return envelope(all.slice(offset, offset + limit), total, offset, limit);
};
const pages = (h: { apiCalls: () => { url: string }[] }) =>
  h.apiCalls().map((c) => { const p = new URL(c.url).searchParams; return `${p.get("offset")}+${p.get("limit")}`; });
const ids = (r: { json: { jobs: { id: number }[] } }) => r.json.jobs.map((j) => j.id);

test("returns next_skip when more Jobs exist, and the next page from it", async () => {
  const h = await harness({ "GET /projects": jobsOf(5) }, { cfg: { pageSize: 2 } });
  const r1 = await h.call("search_jobs", { limit: 3 });
  assert.equal(r1.isError, false, r1.text);
  assert.deepEqual(ids(r1), [100, 101, 102]);
  assert.equal(r1.json.total_matching, 5);
  assert.equal(r1.json.next_skip, 3);
  assert.equal(r1.json.scope, "complete");
  assert.deepEqual(pages(h), ["0+2", "2+1"]);

  const r2 = await h.call("search_jobs", { limit: 3, skip: r1.json.next_skip });
  assert.deepEqual(ids(r2), [103, 104]);
  assert.equal(r2.json.next_skip, undefined);
});

test("large limits page Clearstory in requests of at most 100", async () => {
  const h = await harness({ "GET /projects": jobsOf(260) });
  const r = await h.call("search_jobs", { limit: 250 });
  assert.equal(r.json.returned, 250);
  assert.deepEqual(pages(h), ["0+100", "100+100", "200+50"]);
  assert.equal(r.json.next_skip, 250);
});

test("skip continues into archived Jobs after the active ones", async () => {
  const h = await harness({
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("archived") === "true"
      ? jobsOf(3)(req) : jobsOf(2, 1)(req),
  });
  const r = await h.call("search_jobs", { include_archived: true, skip: 3, limit: 10 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(ids(r), [101, 102]);
  assert.equal(r.json.total_matching, 5);
  assert.equal(r.json.next_skip, undefined);
});

test("the subrequest budget caps a pull: scope partial with next_skip", async () => {
  // budget 3 = token POST + 2 pages of 2
  const h = await harness({ "GET /projects": jobsOf(10) }, { cfg: { pageSize: 2, maxSubrequests: 3 } });
  const r = await h.call("search_jobs", { limit: 10 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.scope, "partial");
  assert.deepEqual(ids(r), [100, 101, 102, 103]);
  assert.equal(r.json.next_skip, 4);
  assert.equal(r.json.total_matching, undefined, "no total claimed when partial");
  assert.equal(h.calls.length, 3, "never exceeds the budget");
});

test("a budget too small for even one page is an error, not an empty list", async () => {
  const h = await harness({ "GET /projects": jobsOf(10) }, { cfg: { maxSubrequests: 1 } });
  const r = await h.call("search_jobs", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /request limit/);
  assert.equal(h.calls.length, 1);
});

test("429 with Retry-After waits as asked, then succeeds", async () => {
  const slept: number[] = [];
  let n = 0;
  const h = await harness({
    "GET /projects": (req: FakeRequest) => (++n <= 2 ? json({ message: "Too Many Requests" }, 429, { "Retry-After": "7" }) : jobsOf(1)(req)),
  }, { sleep: async (ms) => { slept.push(ms); } });
  const r = await h.call("search_jobs", {});
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(ids(r), [100]);
  assert.deepEqual(slept, [7000, 7000]);
  assert.equal(h.apiCalls().length, 3);
});

test("429 gives up after 4 tries and passes the error through", async () => {
  const h = await harness({ "GET /projects": json({ message: "Too Many Requests" }, 429, { "Retry-After": "1" }) });
  const r = await h.call("search_jobs", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 429/);
  assert.equal(h.apiCalls().length, 4);
});

test("a Clearstory 4xx body is passed through, trimmed to 500 chars, without retrying", async () => {
  const long = "x".repeat(600);
  const h = await harness({ "GET /projects": json({ success: false, errors: [{ param: "limit", msg: "must be 1-100", location: "query", value: 0 }], pad: long }, 422) });
  const r = await h.call("search_jobs", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 422/);
  assert.match(r.text, /must be 1-100/);
  assert.match(r.text, /x{100}/);
  assert.doesNotMatch(r.text, /x{500}/, "body trimmed");
  assert.equal(h.apiCalls().length, 1);
});

test("a 401 drops the cached token and retries once with a new one", async () => {
  let tokens = 0;
  const h = await harness({
    "GET /projects": (req: FakeRequest) => (req.url && h.apiCalls().length === 1 ? json({ message: "Unauthorized" }, 401) : jobsOf(1)(req)),
  }, { token: () => json({ access_token: `tok-${++tokens}`, expires_in: 86400 }) });
  const r = await h.call("search_jobs", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(h.tokenPosts(), 2);
  assert.deepEqual(h.apiCalls().map((c) => c.headers.authorization), ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(h.kv.store.get("cs:token")?.includes("tok-2"), true, "KV holds the new token");
});
