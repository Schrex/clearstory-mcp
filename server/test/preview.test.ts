import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest, type HarnessOpts } from "./harness.ts";
import { contractDetail, envelope, projectRecord } from "./fixtures.ts";
import { corSent, corTag } from "./fixtures-cors.ts";
import { createdKey, normalizeTitle, sourceKey } from "../src/tools/draft-cor.ts";

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
    [{ ...ARGS, amount: 1000.01 }, /amount \$1,000.01 is above the \$1,000.00 limit per draft COR/],
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

test("preview_draft_cor dates the footer in New York local time, not UTC", async () => {
  const h = await setup({}, { now: () => new Date("2026-10-29T02:00:00Z") });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.description, /Drafted via Claude by pm@schrex\.com on 2026-10-28\.$/);
});

test("preview_draft_cor refuses a Job with no contract and stores nothing", async () => {
  const h = await setup({ "GET /contracts": envelope([]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, true);
  assert.match(r.text, /Job 23104 has no contract in Clearstory/);
  assert.equal(h.kv.puts.filter((p) => p.key.startsWith("cor-preview:")).length, 0);
});

test("preview_draft_cor shows the contract's GC when the Job has exactly one contract", async () => {
  const h = await setup({ "GET /contracts": envelope([contractDetail({ contractorProject: projectRecord({ customer: "Turner Construction Co." }) })]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.gc, "Turner Construction Co.");
  assert.deepEqual(r.json.warnings, []);
});

test("preview_draft_cor with several contracts shows the Job's GC and warns, listing each contract with its GC, that Clearstory picks the contract", async () => {
  const h = await setup({ "GET /contracts": envelope([
    contractDetail({ contractorProject: projectRecord({ customer: "Turner Construction Co." }) }),
    contractDetail({ id: 9002, name: "Change Work", contractorProject: projectRecord({ customer: "Skanska USA" }) }),
  ]) });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.gc, "Turner Construction");
  assert.deepEqual(r.json.contracts, [{ id: 9001, name: "Prime Sitework" }, { id: 9002, name: "Change Work" }]);
  assert.deepEqual(r.json.warnings, [
    "Job 23104 has 2 contracts: 9001 Prime Sitework (GC Turner Construction Co.); 9002 Change Work (GC Skanska USA). Clearstory picks which contract the draft COR goes on (it can't be chosen here); check it in Clearstory.",
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

// ---- duplicate check by source (#20) ----
const HB = { estimate_code: "B26055", bid_item: "2575" };

test("sourceKey keys a HeavyBid bid item or a T&M Tag id per Job", () => {
  assert.equal(sourceKey(7001, { heavybid: { estimate_code: " b26055 ", bid_item: "2575 " } }), "cor-source:7001:hb:B26055:2575");
  assert.equal(sourceKey(7001, { tm_tag_id: 5101 }), "cor-source:7001:tag:5101");
});

test("preview_draft_cor warns when a bid item was used on an earlier draft COR under a different title, naming that COR", async () => {
  const h = await setup();
  await h.kv.kv.put(sourceKey(7001, { heavybid: HB }), JSON.stringify({ state: "created", cor_id: 6300, cor_number: "COR-002", email: "other@schrex.com", created_at: "2026-10-28T12:00:00.000Z" }));
  const r = await h.call("preview_draft_cor", { ...ARGS, title: "Clay liner, new title", sources: { heavybid: [HB] } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.warnings, [
    "Possible double billing: HeavyBid B26055 bid item 2575 is already on COR-002 (COR id 6300, by other@schrex.com, 2026-10-28), created via Claude on this Job. It may not show in Clearstory's COR list until sent.",
  ]);
});

test("preview_draft_cor warns when a T&M Tag is already on a COR on the Job, naming that COR (Void CORs ignored)", async () => {
  const h = await setup({ "GET /cors": envelope([
    corSent(),
    corSent({ id: 6202, corNumber: "COR-020", title: "Voided", status: "rejected", tmTags: [corTag({ id: 5103 })] }),
  ]) });
  const r = await h.call("preview_draft_cor", { ...ARGS, sources: { tm_tag_ids: [5101, 5103, 5999] } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.warnings, [
    "Possible double billing: T&M Tag id 5101 is already on COR-017 \"Rock excavation at MH-4\" (id 6201, In Review) on this Job.",
  ]);
});

test("preview_draft_cor warns from the ledger when a T&M Tag is on a draft COR we created (drafts aren't listed)", async () => {
  const h = await setup();
  await h.kv.kv.put(sourceKey(7001, { tm_tag_id: 5101 }), JSON.stringify({ state: "unknown", email: "other@schrex.com", created_at: "2026-10-28T12:00:00.000Z" }));
  const r = await h.call("preview_draft_cor", { ...ARGS, sources: { tm_tag_ids: [5101] } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.warnings, [
    "Possible double billing: T&M Tag id 5101 was in a create of a draft COR via Claude on this Job with an unknown outcome (by other@schrex.com, 2026-10-28). Check Clearstory; it may not show in Clearstory's COR list until sent.",
  ]);
});

test("preview_draft_cor puts sources in the description footer and stores them with the preview; no sources = unchanged", async () => {
  const h = await setup();
  const r = await h.call("preview_draft_cor", { ...ARGS, source: "HeavyBid B26055", sources: { heavybid: [HB, { estimate_code: "B26055", bid_item: "2555" }], tm_tag_ids: [5101] } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.description, /on 2026-10-29\.\nSource: HeavyBid B26055\nSources: HeavyBid B26055 bid item 2575; HeavyBid B26055 bid item 2555; T&M Tag id 5101$/);
  const stored = JSON.parse(h.kv.store.get(`cor-preview:${r.json.preview_id}`)!);
  assert.deepEqual(stored.sources, [{ heavybid: HB }, { heavybid: { estimate_code: "B26055", bid_item: "2555" } }, { tm_tag_id: 5101 }]);
  const plain = await h.call("preview_draft_cor", ARGS);
  assert.match(plain.json.description, /on 2026-10-29\.$/);
  assert.equal(JSON.parse(h.kv.store.get(`cor-preview:${plain.json.preview_id}`)!).sources, undefined);
  assert.deepEqual(plain.json.warnings, []);
});

test("preview_draft_cor tells Claude to always pass sources when priced from HeavyBid or T&M Tags", async () => {
  const h = await setup();
  const t = (await h.client.listTools()).tools.find((x) => x.name === "preview_draft_cor")!;
  assert.match(t.description!, /Always pass sources when you priced from HeavyBid bid items or T&M Tags/);
});

test("preview_draft_cor guides pricing: right estimate, round up, copy recent CORs, T&M rates by rate_id, no double markup", async () => {
  const h = await setup();
  const d = (await h.client.listTools()).tools.find((x) => x.name === "preview_draft_cor")!.description!;
  assert.match(d, /estimate code starts with the job number and whose GC\/owner matches the Clearstory Job/);
  assert.match(d, /prefer the Job's -PM estimate for change bid items/);
  assert.match(d, /Round each unit price up to the cent before multiplying by quantity/);
  assert.match(d, /read the Job's most recent CORs \(get_cor\) and copy their markup %, tax and rounding/);
  assert.match(d, /list_rates for the Job and match by rate_id/);
  assert.match(d, /Bid prices already include markup/);
  assert.match(d, /pass pricing/);
});

test("preview_draft_cor echoes pricing as checks for the PM to confirm; unstated items say so; no pricing = no checks", async () => {
  const h = await setup();
  const r = await h.call("preview_draft_cor", { ...ARGS, pricing: { estimate_code: " J2608-PM ", markup_pct: 15, tax_pct: 8, rounding: "up" } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.checks, [
    "Estimate used: J2608-PM",
    "Markup: 15% on top of the bid price",
    "Tax: 8%",
    "Rounding: unit prices rounded up to the cent",
  ]);
  const partial = await h.call("preview_draft_cor", { ...ARGS, pricing: { markup_pct: 0, rounding: "nearest" } });
  assert.deepEqual(partial.json.checks, [
    "Estimate used: not stated",
    "Markup: none on top of the bid price",
    "Tax: not stated",
    "Rounding: unit prices rounded to the nearest cent",
  ]);
  const plain = await h.call("preview_draft_cor", ARGS);
  assert.equal(plain.json.checks, undefined);
});

test("sourceKey escapes ':' so estimate code and bid item can't collide; keys without ':' unchanged", () => {
  const a = sourceKey(7001, { heavybid: { estimate_code: "A:B", bid_item: "C" } });
  const b = sourceKey(7001, { heavybid: { estimate_code: "A", bid_item: "B:C" } });
  assert.notEqual(a, b);
  assert.equal(sourceKey(7001, { heavybid: { estimate_code: "J2608-PM", bid_item: "10  20" } }), "cor-source:7001:hb:J2608-PM:10 20");
});

test("preview_draft_cor dedupes HeavyBid sources by their normalized key", async () => {
  const h = await setup();
  const r = await h.call("preview_draft_cor", { ...ARGS, sources: { heavybid: [HB, { estimate_code: " b26055", bid_item: "2575 " }] } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.description, /Sources: HeavyBid B26055 bid item 2575$/);
  assert.deepEqual(JSON.parse(h.kv.store.get(`cor-preview:${r.json.preview_id}`)!).sources, [{ heavybid: HB }]);
});

test("preview_draft_cor reads the source ledger in parallel", async () => {
  const h = await setup();
  const kv = h.kv.kv as unknown as { get: (k: string) => Promise<string | null> };
  const orig = kv.get;
  let inFlight = 0, max = 0;
  kv.get = async (k: string) => {
    if (k.startsWith("cor-source:")) { inFlight++; max = Math.max(max, inFlight); await new Promise((res) => setTimeout(res, 5)); inFlight--; }
    return orig(k);
  };
  const r = await h.call("preview_draft_cor", { ...ARGS, sources: { heavybid: [HB], tm_tag_ids: [5101, 5102] } });
  assert.equal(r.isError, false, r.text);
  assert.equal(max, 3);
});
