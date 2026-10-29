import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest, type HarnessOpts } from "./harness.ts";
import { contractDetail, envelope, projectRecord } from "./fixtures.ts";
import { corSent } from "./fixtures-cors.ts";
import { createdKey, normalizeTitle } from "../src/tools/draft-cor.ts";

const NOW = () => new Date("2026-10-29T15:00:00.000Z");
const ARGS = { job: "23104", title: "Extra 12in storm, 150 LF", description: "150 LF of 12\" storm at bid price.", amount: 12345.678 };

/** Job 23104 (id 7001) with one contract and no CORs, unless overridden. */
const routes = (over: Record<string, unknown> = {}) => ({
  "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber") === "23104" && req.url.searchParams.get("archived") !== "true"
    ? envelope([projectRecord()]) : envelope([]),
  "GET /contracts": (req: FakeRequest) => req.url.searchParams.get("projectId") === "7001" ? envelope([contractDetail()]) : envelope([]),
  "GET /cors": envelope([]),
  ...over,
});
const setup = (over: Record<string, unknown> = {}, opts: HarnessOpts = {}) =>
  harness(routes(over), { email: "pm@schrex.com", now: NOW, ...opts });

test("preview_draft_cor returns the preview with footer and preview_id, and stores the full body in KV for 15 minutes", async () => {
  const h = await setup();
  const r = await h.call("preview_draft_cor", { ...ARGS, source: "HeavyBid B26055 bid items 2575, 2555" });
  assert.equal(r.isError, false, r.text);
  const description = "150 LF of 12\" storm at bid price.\n\nDrafted via Claude by pm@schrex.com on 2026-10-29.\nSource: HeavyBid B26055 bid items 2575, 2555";
  const { preview_id, ...rest } = r.json;
  assert.match(preview_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(rest, {
    job_number: "23104", job_name: "Route 30 Sewer Extension", gc: "Turner Construction",
    contracts: [{ id: 9001, name: "Prime Sitework" }],
    title: "Extra 12in storm, 150 LF", description, amount: 12345.68,
    recorded_as: "pm@schrex.com", warnings: [],
  });
  const put = h.kv.puts.find((p) => p.key === `cor-preview:${preview_id}`)!;
  assert.ok(put, "preview stored");
  assert.deepEqual(put.opts, { expirationTtl: 900 });
  assert.deepEqual(JSON.parse(put.value), {
    body: { projectId: 7001, title: "Extra 12in storm, 150 LF", description, amount: 12345.68 },
    job_number: "23104", email: "pm@schrex.com", exp: "2026-10-29T15:15:00.000Z",
  });
});

test("preview_draft_cor refuses missing, zero, negative and over-cap amounts and bad titles, before any Clearstory call", async () => {
  const h = await setup({}, { cfg: { maxDraftCorAmount: 1000 } });
  const { amount: _a, ...noAmount } = ARGS;
  const cases: [Record<string, unknown>, RegExp][] = [
    [noAmount, /amount/i],
    [{ ...ARGS, amount: 0 }, /amount must be more than 0/],
    [{ ...ARGS, amount: 0.004 }, /amount must be more than 0/],
    [{ ...ARGS, amount: -50 }, /Credit \(negative\) CORs are not supported/],
    [{ ...ARGS, amount: 1000.01 }, /above the \$1,000 limit per draft COR/],
    [{ ...ARGS, title: "   " }, /title must be 1-255 characters/],
    [{ ...ARGS, title: "x".repeat(256) }, /title must be 1-255 characters/],
  ];
  for (const [args, msg] of cases) {
    const r = await h.call("preview_draft_cor", args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(r.text, msg);
  }
  assert.equal(h.apiCalls().length, 0);
  assert.equal(h.kv.puts.filter((p) => p.key.startsWith("cor-preview:")).length, 0);
  const ok = await h.call("preview_draft_cor", { ...ARGS, amount: 1000, title: "x".repeat(255) });
  assert.equal(ok.isError, false, ok.text);
});

test("preview_draft_cor refuses a Job with no contract and stores nothing", async () => {
  const h = await setup({ "GET /contracts": envelope([]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, true);
  assert.match(r.text, /Job 23104 has no contract in Clearstory/);
  assert.equal(h.kv.puts.filter((p) => p.key.startsWith("cor-preview:")).length, 0);
});

test("preview_draft_cor warns when the Job has several contracts (Clearstory picks one) and names them; GC from the contract", async () => {
  const h = await setup({ "GET /contracts": envelope([
    contractDetail({ contractorProject: projectRecord({ customer: "Turner Construction Co." }) }),
    contractDetail({ id: 9002, name: "Change Work" }),
  ]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.gc, "Turner Construction Co.");
  assert.deepEqual(r.json.contracts, [{ id: 9001, name: "Prime Sitework" }, { id: 9002, name: "Change Work" }]);
  assert.deepEqual(r.json.warnings, [
    "Job 23104 has 2 contracts (9001 Prime Sitework; 9002 Change Work). Clearstory chooses which one the draft COR goes on; check it in Clearstory.",
  ]);
});

test("preview_draft_cor warns about CORs on the Job (any status) with the same or an overlapping title", async () => {
  const h = await setup({ "GET /cors": envelope([
    corSent({ id: 1, corNumber: "COR-001", title: "  EXTRA 12in   storm, 150 lf ", status: "rejected" }),
    corSent({ id: 2, corNumber: "COR-002", title: "Extra 12in storm" }),
    corSent({ id: 3, corNumber: "COR-003", title: "Rock excavation at MH-4" }),
  ]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.warnings, [
    "Possible duplicate: COR-001 \"  EXTRA 12in   storm, 150 lf \" (id 1, Void) on this Job has the same or an overlapping title.",
    "Possible duplicate: COR-002 \"Extra 12in storm\" (id 2, In Review) on this Job has the same or an overlapping title.",
  ]);
  const q = new URL(h.apiCalls().find((c) => new URL(c.url).pathname.endsWith("/cors"))!.url).searchParams;
  assert.equal(q.get("projectIds"), "7001");
  assert.equal(q.get("statuses"), null, "all statuses incl. Void");
});

test("preview_draft_cor warns when the created-draft ledger has a draft with this title on the Job", async () => {
  const h = await setup();
  await h.kv.kv.put(createdKey(7001, "extra 12in storm, 150 lf"), JSON.stringify({ cor_id: 6300, email: "other@schrex.com", created_at: "2026-10-28T12:00:00.000Z" }));
  const r = await h.call("preview_draft_cor", { ...ARGS, title: "Extra 12in  Storm, 150 LF" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.warnings, [
    "Possible duplicate: a draft COR with this title was already created via Claude on this Job (COR id 6300, by other@schrex.com, 2026-10-28). It may not show in Clearstory's COR list until sent.",
  ]);
});

test("preview_draft_cor is listed as read-only and tells Claude to confirm with the user before create_draft_cor", async () => {
  const h = await setup();
  const t = (await h.client.listTools()).tools.find((x) => x.name === "preview_draft_cor")!;
  assert.equal(t.annotations?.readOnlyHint, true);
  assert.match(t.description!, /call create_draft_cor with the preview_id only after the user says yes/);
});

test("preview_draft_cor sends only GETs and writes an audit log line and KV record without title or description", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (s: string) => { logs.push(s); });
  const h = await setup({ "GET /cors": envelope([corSent()]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.apiCalls().map((c) => c.method), ["GET", "GET", "GET"]);
  const audit = { evt: "cor_preview", email: "pm@schrex.com", job: "23104", amount: 12345.68, preview_id: r.json.preview_id, at: "2026-10-29T15:00:00.000Z" };
  assert.deepEqual(logs.map((l) => JSON.parse(l)), [audit]);
  const put = h.kv.puts.find((p) => p.key.startsWith("cor-audit:"))!;
  assert.equal(put.key, `cor-audit:2026-10-29T15:00:00.000Z:${r.json.preview_id}`);
  assert.deepEqual(JSON.parse(put.value), audit);
  assert.deepEqual(put.opts, { expirationTtl: 400 * 24 * 60 * 60 });
  for (const s of [...logs, put.value]) assert.doesNotMatch(s, /storm|bid price/i);
});

test("normalizeTitle ignores case and extra whitespace", () => {
  assert.equal(normalizeTitle("  Extra 12in\t Storm,  150 LF "), "extra 12in storm, 150 lf");
  assert.equal(createdKey(7001, "Extra  Storm"), "cor-created:7001:extra storm");
});

test("preview_draft_cor unknown job number returns close matches", async () => {
  const h = await setup({ "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber")
    ? envelope([]) : envelope([projectRecord()]) });
  const r = await h.call("preview_draft_cor", { ...ARGS, job: "2310" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No Job with job number '2310'\. Close matches: 23104 Route 30 Sewer Extension/);
});
