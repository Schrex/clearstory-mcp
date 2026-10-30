import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, fakeKv, type FakeRequest } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";
import { tmTag } from "./fixtures-tags.ts";
import { corSent, corTag } from "./fixtures-cors.ts";
import { sourceKey } from "../src/tools/draft-cor.ts";

// J25008 (2026-10-30 retest): EX00385 + EX00388 signed and on no COR; EX00380/EX00381 on COR 7.
const JOB = 7250;
const NOW = () => new Date("2026-10-30T15:00:00.000Z");
const tag = (id: number, num: string, over: Record<string, unknown> = {}) => tmTag({
  id, projectId: JOB, number: num, paddedTagNumber: num, status: "signed",
  dateOfWorkPerformed: "2026-10-01T00:00:00.000Z", dateOfWorkPerformedAdditional: [], signedAt: "2026-10-03T14:00:00.000Z",
  totalHours: 8, ...over,
});
const J25008_TAGS = [
  tag(9388, "EX00388", { dateOfWorkPerformed: "2026-10-09T00:00:00.000Z", signedAt: "2026-10-10T14:00:00.000Z", totalHours: 6.5 }),
  tag(9385, "EX00385", { dateOfWorkPerformed: "2026-10-02T00:00:00.000Z", signedAt: "2026-10-05T14:00:00.000Z", totalHours: 10 }),
  tag(9380, "EX00380"),
  tag(9381, "EX00381", { status: "signed_not_sent" }),
  tag(9390, "EX00390", { status: "awaiting_signature" }),
  tag(9391, "EX00391", { status: "rejected" }),
  tag(9392, "EX00392", { status: "draft" }),
];
const COR_7 = corSent({ id: 6307, corNumber: "7", projectId: JOB, jobNumber: "J25008", tmTagCount: 2, tmTags: [corTag({ id: 9380 }), corTag({ id: 9381 })] });

const jobRoute = (req: FakeRequest) =>
  req.url.searchParams.get("jobNumber") === "J25008" && req.url.searchParams.get("archived") !== "true"
    ? envelope([projectRecord({ id: JOB, jobNumber: "J25008" })]) : envelope([]);
const routes = (tags: unknown[] = J25008_TAGS, cors: unknown[] = [COR_7]) =>
  ({ "GET /projects": jobRoute, "GET /tags": envelope(tags), "GET /cors": envelope(cors) });
const params = (h: { apiCalls: () => { url: string }[] }, end: string) =>
  h.apiCalls().filter((c) => new URL(c.url).pathname.endsWith(end)).map((c) => new URL(c.url).searchParams);
const numbers = (r: { json: { unbilled_tm_tags: { tag_number: string }[] } }) => r.json.unbilled_tm_tags.map((t) => t.tag_number);

test("list_unbilled_tm_tags J25008: EX00385 + EX00388 unbilled, oldest first; tags on COR 7 excluded", async () => {
  const h = await harness(routes(), { now: NOW });
  const r = await h.call("list_unbilled_tm_tags", { job: "J25008" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(numbers(r), ["EX00385", "EX00388"]);
  assert.deepEqual(r.json.unbilled_tm_tags[0], {
    id: 9385, tag_number: "EX00385", job_id: JOB, status: "signed", work_date: "2026-10-02",
    hcss_timecard_id: "hj-tc-88123", total_hours: 10, signed_on: "2026-10-05", days_since_signed: 25,
  });
  assert.deepEqual(r.json.jobs, [{ job_id: JOB, unbilled_tm_tags: 2, total_hours: 16.5 }]);
  assert.equal(r.json.scope, "complete");
  const cor = params(h, "/cors")[0];
  assert.equal(cor.get("hasTags"), "1");
  assert.equal(cor.get("projectIds"), String(JOB));
  assert.equal(params(h, "/tags")[0].get("projectId"), String(JOB));
});

test("list_unbilled_tm_tags: unsigned, rejected and draft T&M Tags are never unbilled; pulls signed statuses only", async () => {
  const h = await harness(routes(), { now: NOW });
  const r = await h.call("list_unbilled_tm_tags", { job: "J25008" });
  assert.equal(r.isError, false, r.text);
  for (const n of ["EX00390", "EX00391", "EX00392"]) assert.doesNotMatch(r.text, new RegExp(n));
  assert.deepEqual(params(h, "/tags").map((p) => p.get("status")).sort(), ["signed", "signed_not_sent"]);
});

test("list_unbilled_tm_tags: draft-COR caveat; a T&M Tag in the cor-source ledger is on_draft_cor, not unbilled; no KV writes", async () => {
  const kv = fakeKv();
  kv.store.set(sourceKey(JOB, { tm_tag_id: 9388 }), JSON.stringify({ state: "created", cor_id: 6400, cor_number: "12", created_at: "2026-10-20T12:00:00.000Z" }));
  const h = await harness(routes(), { now: NOW, kv });
  const r = await h.call("list_unbilled_tm_tags", { job: "J25008" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.caveat, /draft COR/);
  assert.deepEqual(numbers(r), ["EX00385"]);
  assert.equal(r.json.on_draft_cor.length, 1);
  assert.equal(r.json.on_draft_cor[0].tag_number, "EX00388");
  assert.deepEqual(r.json.on_draft_cor[0].draft_cor, { cor_id: 6400, cor_number: "12", state: "created", created_at: "2026-10-20" });
  assert.deepEqual(r.json.jobs, [{ job_id: JOB, unbilled_tm_tags: 1, total_hours: 10 }]);
  assert.equal(kv.puts.filter((p) => p.key.startsWith("cor-")).length, 0);
});

test("list_unbilled_tm_tags: default window is the last 60 days of work dates; a window narrows it", async () => {
  const old = tag(9300, "EX00300", { dateOfWorkPerformed: "2026-08-15T00:00:00.000Z", signedAt: "2026-08-20T14:00:00.000Z" });
  const h = await harness(routes([...J25008_TAGS, old]), { now: NOW });
  const r = await h.call("list_unbilled_tm_tags", { job: "J25008" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.work_date_from, "2026-08-31");
  assert.equal(r.json.work_date_until, "2026-10-30");
  assert.deepEqual(numbers(r), ["EX00385", "EX00388"]);
  assert.equal(params(h, "/tags")[0].get("fromUpdatedAt"), "2026-08-31T00:00:00.000Z");
  const w = await h.call("list_unbilled_tm_tags", { job: "J25008", work_date_from: "2026-10-05", work_date_until: "2026-10-31" });
  assert.deepEqual(numbers(w), ["EX00388"]);
});

test("list_unbilled_tm_tags: all Jobs gives totals per Job", async () => {
  const other = tag(9501, "EX00501", { projectId: 7001, totalHours: 4 });
  const h = await harness(routes([...J25008_TAGS, other]), { now: NOW });
  const r = await h.call("list_unbilled_tm_tags", {});
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(numbers(r), ["EX00501", "EX00385", "EX00388"]);
  assert.deepEqual(r.json.jobs, [{ job_id: 7001, unbilled_tm_tags: 1, total_hours: 4 }, { job_id: JOB, unbilled_tm_tags: 2, total_hours: 16.5 }]);
  assert.equal(params(h, "/cors")[0].get("projectIds"), null);
});

test("list_unbilled_tm_tags: scope partial when paging hits the subrequest budget", async () => {
  const many = (req: FakeRequest) => {
    const limit = Number(req.url.searchParams.get("limit"));
    const offset = Number(req.url.searchParams.get("offset"));
    const all = Array.from({ length: 10 }, (_, i) => tag(9600 + i, `EX006${i}`));
    return envelope(all.slice(offset, offset + limit), all.length, offset, limit);
  };
  const h = await harness({ ...routes(), "GET /tags": many }, { now: NOW, cfg: { pageSize: 2, maxSubrequests: 3 } });
  const r = await h.call("list_unbilled_tm_tags", { job_id: JOB });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.scope, "partial");
  assert.match(r.json.note, /request limit/);
});
