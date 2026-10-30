// create_draft_cor (#15): creates the draft COR from a stored preview. These harnesses use `writes: true`,
// so this file asserts its own requests; every other test file stays under the suite-wide GET-only check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, json, type FakeRequest, type HarnessOpts } from "./harness.ts";
import { contractDetail, envelope, projectRecord } from "./fixtures.ts";
import { corDetail, corSent } from "./fixtures-cors.ts";
import { createdKey, sourceKey } from "../src/tools/draft-cor.ts";

const NOW = () => new Date("2026-10-29T15:00:00.000Z");
const ARGS = { job: "23104", title: "Extra 12in storm, 150 LF", description: "150 LF of 12\" storm at bid price.", amount: 12345.678 };
const created = () => json(corDetail({ id: 6301, corNumber: "COR-018", status: "placeholder", stage: "draft", requestedAmount: 12345.68 }), 201);

/** Job 23104 (id 7001) with one contract and no CORs; POST /cors answers 201 unless overridden. */
const routes = (over: Record<string, unknown> = {}) => ({
  "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber") === "23104" ? envelope([projectRecord()]) : envelope([]),
  "GET /contracts": envelope([contractDetail()]),
  "GET /cors": envelope([]),
  "POST /cors": created,
  ...over,
});
const setup = (over: Record<string, unknown> = {}, opts: HarnessOpts = {}) =>
  harness(routes(over), { email: "pm@schrex.com", now: NOW, writes: true, ...opts });

/** Preview, then return the preview_id and the stored body. */
async function preview(h: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown> = ARGS) {
  const r = await h.call("preview_draft_cor", args);
  assert.equal(r.isError, false, r.text);
  return r.json as { preview_id: string; description: string };
}
const posts = (h: Awaited<ReturnType<typeof setup>>) => h.apiCalls().filter((c) => c.method === "POST");

test("create_draft_cor sends exactly one POST /cors with the stored preview body and returns the COR id, number, status and amount", async () => {
  const h = await setup();
  const p = await preview(h, { ...ARGS, source: "HeavyBid B26055" });
  const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json, { state: "created", cor_id: 6301, cor_number: "COR-018", status: "Placeholder", amount: 12345.68, job_number: "23104" });
  assert.equal(posts(h).length, 1);
  assert.deepEqual(JSON.parse(posts(h)[0].body!), { projectId: 7001, title: "Extra 12in storm, 150 LF", description: p.description, amount: 12345.68 });
  assert.match(p.description, /Drafted via Claude by pm@schrex\.com on 2026-10-29\.\nSource: HeavyBid B26055$/);
});

test("create_draft_cor takes only preview_id and is listed as a non-read-only, non-idempotent, non-destructive write", async () => {
  const h = await setup();
  const t = (await h.client.listTools()).tools.find((x) => x.name === "create_draft_cor")!;
  assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}), ["preview_id"]);
  assert.deepEqual(t.inputSchema.required, ["preview_id"]);
  assert.equal(t.annotations?.readOnlyHint, false);
  assert.equal(t.annotations?.destructiveHint, false);
  assert.equal(t.annotations?.idempotentHint, false);
});

test("a second create_draft_cor with the same preview_id is refused and sends no second POST", async () => {
  const h = await setup();
  const p = await preview(h);
  assert.equal((await h.call("create_draft_cor", { preview_id: p.preview_id })).isError, false);
  const again = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(again.isError, true);
  assert.match(again.text, /Unknown or expired preview_id.*preview_draft_cor again/);
  assert.equal(posts(h).length, 1);
});

test("create_draft_cor refuses an unknown preview_id, an expired preview and another person's preview, sending nothing", async () => {
  const h = await setup();
  const unknown = await h.call("create_draft_cor", { preview_id: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown or expired preview_id/);

  const p = await preview(h);
  const later = await harness(routes(), { email: "pm@schrex.com", now: () => new Date("2026-10-29T15:15:00.001Z"), writes: true, kv: h.kv });
  const expired = await later.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(expired.isError, true);
  assert.match(expired.text, /Unknown or expired preview_id/);

  const q = await preview(h);
  const other = await harness(routes(), { email: "someone@schrex.com", now: NOW, writes: true, kv: h.kv });
  const r = await other.call("create_draft_cor", { preview_id: q.preview_id });
  assert.equal(r.isError, true);
  assert.match(r.text, /made by a different signed-in person/);
  assert.equal([...h.calls, ...later.calls, ...other.calls].filter((c) => c.method === "POST" && c.url !== h.cfg.tokenUrl).length, 0);
  // Another person's attempt does not use up the preview.
  assert.equal((await h.call("create_draft_cor", { preview_id: q.preview_id })).isError, false);
});

/** Audit lines logged during fn, parsed, minus the preview's own. */
async function audits(t: { mock: { method: (o: object, m: string, f: (s: string) => void) => unknown } }) {
  const logs: string[] = [];
  t.mock.method(console, "log", (s: string) => { logs.push(s); });
  return logs;
}
const createAudits = (logs: string[]) => logs.map((l) => JSON.parse(l)).filter((a) => a.evt !== "cor_preview");

test("created: writes the 30-day ledger entry and an audit log line and KV record without title or description", async (t) => {
  const logs = await audits(t);
  const h = await setup();
  const p = await preview(h);
  const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(r.isError, false, r.text);
  const ledger = h.kv.puts.find((x) => x.key === createdKey(7001, ARGS.title))!;
  assert.ok(ledger, "ledger written");
  assert.deepEqual(ledger.opts, { expirationTtl: 30 * 24 * 60 * 60 });
  assert.deepEqual(JSON.parse(ledger.value), { state: "created", cor_id: 6301, cor_number: "COR-018", email: "pm@schrex.com", created_at: "2026-10-29T15:00:00.000Z" });
  const audit = { evt: "cor_created", email: "pm@schrex.com", job: "23104", amount: 12345.68, cor_id: 6301, cor_number: "COR-018", preview_id: p.preview_id, at: "2026-10-29T15:00:00.000Z" };
  assert.deepEqual(createAudits(logs), [audit]);
  const put = h.kv.puts.find((x) => x.key.startsWith("cor-audit:") && x.value.includes("cor_created"))!;
  assert.deepEqual(JSON.parse(put.value), audit);
  assert.deepEqual(put.opts, { expirationTtl: 400 * 24 * 60 * 60 });
  for (const s of [...logs, put.value]) assert.doesNotMatch(s, /storm|bid price/i);
});

test("after a create, a new preview with the same title on the Job warns from the ledger", async () => {
  const h = await setup();
  const p = await preview(h);
  await h.call("create_draft_cor", { preview_id: p.preview_id });
  const r = await h.call("preview_draft_cor", { ...ARGS, title: "extra 12IN storm,  150 lf" });
  assert.deepEqual(r.json.warnings, [
    "Possible duplicate: a draft COR with this title was already created via Claude on this Job (COR id 6301, by pm@schrex.com, 2026-10-29). It may not show in Clearstory's COR list until sent.",
  ]);
});

test("422: Clearstory's message is returned, nothing retried, the preview is used up and cor_refused is audited", async (t) => {
  const logs = await audits(t);
  const h = await setup({ "POST /cors": () => json({ success: false, message: "unknown contract" }, 422) });
  const p = await preview(h);
  const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 422 - .*unknown contract/);
  assert.match(r.text, /not created.*call preview_draft_cor again/i);
  assert.equal(posts(h).length, 1);
  assert.equal(h.kv.puts.filter((x) => x.key.startsWith("cor-created:")).length, 0, "no ledger entry");
  assert.deepEqual(createAudits(logs), [{ evt: "cor_refused", email: "pm@schrex.com", job: "23104", amount: 12345.68, reason: "http_422", preview_id: p.preview_id, at: "2026-10-29T15:00:00.000Z" }]);
  assert.match((await h.call("create_draft_cor", { preview_id: p.preview_id })).text, /Unknown or expired preview_id/);
  assert.equal(posts(h).length, 1);
});

const unknowns: [string, () => Response | Promise<Response>][] = [
  ["503", () => json({ message: "unavailable" }, 503)],
  ["timeout", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))],
  ["unparseable 2xx", () => new Response("<html>ok</html>", { status: 201 })],
];
for (const [name, answer] of unknowns) {
  test(`${name}: state unknown, exactly one POST and no GET, Draft COR Log message, ledger marked unknown, cor_unknown audited`, async (t) => {
    const logs = await audits(t);
    const h = await setup({ "POST /cors": answer });
    const p = await preview(h);
    const before = h.apiCalls().length;
    const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.state, "unknown");
    assert.match(r.json.message, /Draft COR Log/);
    assert.match(r.json.message, /before previewing again/i);
    assert.equal(r.json.probably_created, undefined);
    assert.deepEqual(h.apiCalls().slice(before).map((c) => c.method), ["POST"]);
    const ledger = h.kv.puts.find((x) => x.key === createdKey(7001, ARGS.title))!;
    assert.deepEqual(JSON.parse(ledger.value), { state: "unknown", email: "pm@schrex.com", created_at: "2026-10-29T15:00:00.000Z" });
    assert.deepEqual(ledger.opts, { expirationTtl: 30 * 24 * 60 * 60 });
    assert.deepEqual(createAudits(logs), [{ evt: "cor_unknown", email: "pm@schrex.com", job: "23104", amount: 12345.68, preview_id: p.preview_id, at: "2026-10-29T15:00:00.000Z" }]);
  });
}

test("a preview after an unknown outcome warns that a draft with this title may already exist", async () => {
  const h = await setup({ "POST /cors": () => json({}, 500) });
  await h.call("create_draft_cor", { preview_id: (await preview(h)).preview_id });
  const r = await h.call("preview_draft_cor", ARGS);
  assert.deepEqual(r.json.warnings, [
    "Possible duplicate: a create of a draft COR with this title via Claude on this Job had an unknown outcome (by pm@schrex.com, 2026-10-29). Check Clearstory; it may not show in Clearstory's COR list until sent.",
  ]);
});

// ---- source ledger (#20) ----
const SOURCES = { heavybid: [{ estimate_code: "B26055", bid_item: "2575" }], tm_tag_ids: [5101] };
const sourcePuts = (h: Awaited<ReturnType<typeof setup>>) => h.kv.puts.filter((x) => x.key.startsWith("cor-source:"));

test("created: writes a 365-day source ledger entry per source holding the COR number; a later preview under another title warns", async () => {
  const h = await setup();
  const p = await preview(h, { ...ARGS, sources: SOURCES });
  assert.equal((await h.call("create_draft_cor", { preview_id: p.preview_id })).isError, false);
  const puts = sourcePuts(h);
  assert.deepEqual(puts.map((x) => x.key), [sourceKey(7001, { heavybid: SOURCES.heavybid[0] }), sourceKey(7001, { tm_tag_id: 5101 })]);
  for (const x of puts) {
    assert.deepEqual(x.opts, { expirationTtl: 365 * 24 * 60 * 60 });
    assert.deepEqual(JSON.parse(x.value), { state: "created", cor_id: 6301, cor_number: "COR-018", email: "pm@schrex.com", created_at: "2026-10-29T15:00:00.000Z" });
  }
  const r = await h.call("preview_draft_cor", { ...ARGS, title: "Clay liner", sources: { heavybid: SOURCES.heavybid } });
  assert.deepEqual(r.json.warnings, [
    "Possible double billing: HeavyBid B26055 bid item 2575 is already on COR-018 (COR id 6301, by pm@schrex.com, 2026-10-29), created via Claude on this Job. It may not show in Clearstory's COR list until sent.",
  ]);
});

test("source ledger is written on an unknown outcome, not on a refused create, and not without sources", async () => {
  const unknown = await setup({ "POST /cors": () => json({}, 503) });
  await unknown.call("create_draft_cor", { preview_id: (await preview(unknown, { ...ARGS, sources: SOURCES })).preview_id });
  assert.equal(sourcePuts(unknown).length, 2);
  for (const x of sourcePuts(unknown)) assert.equal(JSON.parse(x.value).state, "unknown");

  const refused = await setup({ "POST /cors": () => json({ message: "no" }, 422) });
  await refused.call("create_draft_cor", { preview_id: (await preview(refused, { ...ARGS, sources: SOURCES })).preview_id });
  assert.equal(sourcePuts(refused).length, 0);

  const plain = await setup();
  await plain.call("create_draft_cor", { preview_id: (await preview(plain)).preview_id });
  assert.equal(sourcePuts(plain).length, 0);
});

// ---- post-POST bookkeeping never turns a created COR into an error ----
const failKvPuts = (h: Awaited<ReturnType<typeof setup>>) => {
  (h.kv.kv as unknown as { put: () => Promise<void> }).put = async () => { throw new Error("KV put failed"); };
};

test("created: a KV failure writing the ledger/audit still returns state created with the COR id and number, plus a note", async () => {
  const h = await setup();
  const p = await preview(h, { ...ARGS, sources: SOURCES });
  failKvPuts(h);
  const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.state, "created");
  assert.equal(r.json.cor_id, 6301);
  assert.equal(r.json.cor_number, "COR-018");
  assert.match(r.json.note, /duplicate.*not (fully )?saved/i);
  assert.equal(posts(h).length, 1);
});

test("unknown: a KV failure writing the ledger/audit still returns state unknown with a note", async () => {
  const h = await setup({ "POST /cors": () => json({}, 503) });
  const p = await preview(h, { ...ARGS, sources: SOURCES });
  failKvPuts(h);
  const r = await h.call("create_draft_cor", { preview_id: p.preview_id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.state, "unknown");
  assert.match(r.json.message, /Draft COR Log/);
  assert.match(r.json.note, /duplicate.*not (fully )?saved/i);
});

test("created: no note when bookkeeping succeeds", async () => {
  const h = await setup();
  const r = await h.call("create_draft_cor", { preview_id: (await preview(h)).preview_id });
  assert.equal(r.json.note, undefined);
});
