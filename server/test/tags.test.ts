import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";
import { tmTag, tmTagDetail } from "./fixtures-tags.ts";

const tagCalls = (h: { apiCalls: () => { url: string }[] }) =>
  h.apiCalls().filter((c) => new URL(c.url).pathname.endsWith("/tags")).map((c) => new URL(c.url).searchParams);

test("list_tm_tags: every T&M Tag carries hcss_timecard_id, cost code, work date, status, total hours; Sent inbox by default", async () => {
  const h = await harness({ "GET /tags": envelope([tmTag(), tmTag({ id: 5502, hcssTimecardId: null, costCode: "  TM-2200 ", status: "awaiting_signature" })]) });
  const r = await h.call("list_tm_tags", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(tagCalls(h)[0].get("inbox"), "sent");
  assert.deepEqual(r.json.tm_tags[0], {
    id: 5501, tag_number: "0042", title: "Rock removal at MH-7", job_id: 7001, status: "signed",
    work_date: "2026-10-14", cost_code: "TM-2100", hcss_timecard_id: "hj-tc-88123", total_hours: 18.1235,
    gc_signer: "Pat Foreman", signed_on: "2026-10-15",
  });
  const t2 = r.json.tm_tags[1];
  assert.ok("hcss_timecard_id" in t2, "hcss_timecard_id present even when absent");
  assert.equal(t2.hcss_timecard_id, null);
  assert.equal(t2.cost_code, "TM-2200", "cost code trimmed");
  assert.equal(t2.status, "awaiting_signature");
  assert.doesNotMatch(r.text, /project|customer/i);
});

const jobRoute = (req: FakeRequest) =>
  req.url.searchParams.get("jobNumber") === "23104" && req.url.searchParams.get("archived") !== "true" ? envelope([projectRecord()]) : envelope([]);

test("list_tm_tags passes Job, status and updated range to Clearstory", async () => {
  const h = await harness({ "GET /projects": jobRoute, "GET /tags": envelope([tmTag()]) });
  const r = await h.call("list_tm_tags", {
    job: "23104", status: "awaiting_signature", updated_from: "2026-10-01", updated_until: "2026-10-31",
  });
  assert.equal(r.isError, false, r.text);
  const p = tagCalls(h)[0];
  assert.equal(p.get("projectId"), "7001");
  assert.equal(p.get("status"), "awaiting_signature");
  assert.equal(p.get("fromUpdatedAt"), "2026-10-01T00:00:00.000Z");
  assert.equal(p.get("untilUpdatedAt"), "2026-10-31T23:59:59.999Z");
  assert.equal(p.get("inbox"), "sent");
});

test("list_tm_tags: Received inbox and Clearstory Job id", async () => {
  const h = await harness({ "GET /tags": envelope([tmTag()]) });
  const r = await h.call("list_tm_tags", { inbox: "received", job_id: 7009 });
  assert.equal(r.isError, false, r.text);
  const p = tagCalls(h)[0];
  assert.equal(p.get("inbox"), "received");
  assert.equal(p.get("projectId"), "7009");
  assert.equal(h.apiCalls().length, 1, "job_id needs no lookup");
});

test("list_tm_tags rejects a bad status before calling Clearstory", async () => {
  const h = await harness({ "GET /tags": envelope([]) });
  const r = await h.call("list_tm_tags", { status: "approved" });
  assert.equal(r.isError, true);
  assert.equal(h.apiCalls().length, 0);
});

test("list_tm_tags date errors name the field; updated_from after updated_until is an error", async () => {
  const h = await harness({ "GET /tags": envelope([]) });
  const bad = await h.call("list_tm_tags", { work_date: "10/14/2026" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /work_date must be a date as YYYY-MM-DD/);
  const flip = await h.call("list_tm_tags", { updated_from: "2026-10-31", updated_until: "2026-10-01" });
  assert.equal(flip.isError, true);
  assert.match(flip.text, /updated_from \(2026-10-31\) is after updated_until/);
  assert.equal(h.apiCalls().length, 0);
});

/** A /tags that serves `total` T&M Tags honouring limit/offset like Clearstory. */
const tagsOf = (total: number) => (req: FakeRequest) => {
  const limit = Number(req.url.searchParams.get("limit"));
  const offset = Number(req.url.searchParams.get("offset"));
  const all = Array.from({ length: total }, (_, i) => tmTag({ id: 6000 + i }));
  return envelope(all.slice(offset, offset + limit), total, offset, limit);
};
const tagIds = (r: { json: { tm_tags: { id: number }[] } }) => r.json.tm_tags.map((t) => t.id);

test("list_tm_tags pages with next_skip", async () => {
  const h = await harness({ "GET /tags": tagsOf(5) }, { cfg: { pageSize: 2 } });
  const r1 = await h.call("list_tm_tags", { limit: 3 });
  assert.equal(r1.isError, false, r1.text);
  assert.deepEqual(tagIds(r1), [6000, 6001, 6002]);
  assert.equal(r1.json.total_matching, 5);
  assert.equal(r1.json.next_skip, 3);
  assert.equal(r1.json.scope, "complete");
  const r2 = await h.call("list_tm_tags", { limit: 3, skip: 3 });
  assert.deepEqual(tagIds(r2), [6003, 6004]);
  assert.equal(r2.json.next_skip, undefined);
  assert.ok(tagCalls(h).every((p) => p.get("inbox") === "sent"), "inbox kept on every page");
});

test("list_tm_tags: the subrequest budget gives scope partial with next_skip", async () => {
  const h = await harness({ "GET /tags": tagsOf(10) }, { cfg: { pageSize: 2, maxSubrequests: 3 } });
  const r = await h.call("list_tm_tags", { limit: 10 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.scope, "partial");
  assert.deepEqual(tagIds(r), [6000, 6001, 6002, 6003]);
  assert.equal(r.json.next_skip, 4);
  assert.equal(r.json.total_matching, undefined);
  assert.match(r.json.note, /request limit/);
});

test("list_tm_tags detail adds hours by ST/OT/DT, signers, signed document and timestamps", async () => {
  const h = await harness({ "GET /tags": envelope([tmTag()]) });
  const r = await h.call("list_tm_tags", { detail: true });
  assert.equal(r.isError, false, r.text);
  const t = r.json.tm_tags[0];
  assert.equal(t.hcss_timecard_id, "hj-tc-88123");
  assert.equal(t.hours_st, 16);
  assert.equal(t.hours_ot, 2.1235);
  assert.equal(t.hours_dt, 0);
  assert.deepEqual(t.more_work_dates, ["2026-10-15"]);
  assert.equal(t.gc_reference_number, "T-CN-17");
  assert.equal(t.signed_document, "https://example.invalid/tags/5501-signed.pdf");
  assert.equal(t.our_signer, "Sam Super");
  assert.equal(t.updated_at, "2026-10-15T13:05:00.000Z");
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("list_tm_tags detail keeps hcss_timecard_id null when absent", async () => {
  const h = await harness({ "GET /tags": envelope([tmTag({ hcssTimecardId: null })]) });
  const r = await h.call("list_tm_tags", { detail: true });
  assert.equal(r.json.tm_tags[0].hcss_timecard_id, null);
});

test("list_tm_tags with an unknown job number errors with close matches", async () => {
  const h = await harness({
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber") ? envelope([]) : envelope([projectRecord()]),
    "GET /tags": envelope([tmTag()]),
  });
  const r = await h.call("list_tm_tags", { job: "23140" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No Job with job number '23140'.*23104/);
  assert.equal(tagCalls(h).length, 0);
});

test("get_tm_tag returns the Job, labor/material/equipment/other items, GC signer, signed time and signed document", async () => {
  const h = await harness({ "GET /tags/5501": tmTagDetail() });
  const r = await h.call("get_tm_tag", { id: 5501 });
  assert.equal(r.isError, false, r.text);
  const t = r.json;
  assert.equal(t.id, 5501);
  assert.equal(t.hcss_timecard_id, "hj-tc-88123");
  assert.equal(t.cost_code, "TM-2100");
  assert.equal(t.work_date, "2026-10-14");
  assert.equal(t.status, "signed");
  assert.deepEqual(t.job, { id: 7001, job_number: "23104", name: "Route 30 Sewer Extension", gc: "Turner Construction" });
  assert.equal(t.gc_signer, "Pat Foreman");
  assert.equal(t.gc_signed_at, "2026-10-15T13:05:00.000Z");
  assert.equal(t.signed_document, "https://example.invalid/tags/5501-signed.pdf");
  assert.deepEqual(t.labor, [{ date: "2026-10-14", labor_class: "Operator", workers: 2, hours: 8.5, unit: "hr" }]);
  assert.deepEqual(t.material, [{ date: "2026-10-14", material: "2A stone", quantity: 12.25, unit: "ton" }]);
  assert.deepEqual(t.equipment, [{ date: "2026-10-14", equipment: "CAT 336 excavator", quantity: 1, unit_quantity: 8, unit: "hr" }]);
  assert.deepEqual(t.other, [{ date: "2026-10-14", item: "Dump fees", quantity: 3, unit_quantity: 1, unit: "load" }]);
  assert.equal(t.hours_st, 16);
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("get_tm_tag keeps hcss_timecard_id null and empty item lists when absent", async () => {
  const h = await harness({ "GET /tags/5502": tmTagDetail({ id: 5502, hcssTimecardId: null, labor: [], material: undefined }) });
  const r = await h.call("get_tm_tag", { id: 5502 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.hcss_timecard_id, null);
  assert.deepEqual(r.json.labor, []);
  assert.deepEqual(r.json.material, []);
});

test("get_tm_tag detail adds rate ids, recipients and creator", async () => {
  const h = await harness({ "GET /tags/5501": tmTagDetail() });
  const r = await h.call("get_tm_tag", { id: 5501, detail: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.labor[0].rate_id, 301);
  assert.equal(r.json.labor[0].internal_id, "OP1");
  assert.deepEqual(r.json.email_to, ["pat@turner.example"]);
  assert.equal(r.json.created_by, "Sam Super");
});

test("get_tm_tag passes a Clearstory 404 through", async () => {
  const h = await harness({});
  const r = await h.call("get_tm_tag", { id: 999 });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 404/);
});

const workDated = () => envelope([
  tmTag({ id: 1, dateOfWorkPerformed: "2026-09-28T00:00:00.000Z", dateOfWorkPerformedAdditional: [] }),
  tmTag({ id: 2, dateOfWorkPerformed: "2026-10-02T00:00:00.000Z", dateOfWorkPerformedAdditional: [] }),
  tmTag({ id: 3, dateOfWorkPerformed: "2026-09-25T00:00:00.000Z", dateOfWorkPerformedAdditional: ["2026-10-05T00:00:00.000Z"] }),
  tmTag({ id: 4, dateOfWorkPerformed: "2026-10-20T00:00:00.000Z", dateOfWorkPerformedAdditional: null }),
]);

test("list_tm_tags work_date_from/until (Unbilled T&M window): updated since the window start, matched on any work date", async () => {
  const h = await harness({ "GET /tags": workDated() });
  const r = await h.call("list_tm_tags", { work_date_from: "2026-10-01", work_date_until: "2026-10-10" });
  assert.equal(r.isError, false, r.text);
  const p = tagCalls(h)[0];
  assert.equal(p.get("fromUpdatedAt"), "2026-10-01T00:00:00.000Z", "a tag is updated on/after its work date");
  assert.equal(p.get("dateOfWorkPerformed"), null);
  assert.deepEqual(tagIds(r), [2, 3], "additional work dates count");
  assert.equal(r.json.total_matching, 2);
  assert.equal(r.json.scope, "complete");
});

test("list_tm_tags work_date matches the main or an additional work date", async () => {
  const h = await harness({ "GET /tags": workDated() });
  const r = await h.call("list_tm_tags", { work_date: "2026-10-05" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(tagIds(r), [3]);
  assert.equal(tagCalls(h)[0].get("fromUpdatedAt"), "2026-10-05T00:00:00.000Z");
});

test("list_tm_tags work date window pages the filtered list and stays partial when capped", async () => {
  const many = (req: FakeRequest) => {
    const limit = Number(req.url.searchParams.get("limit"));
    const offset = Number(req.url.searchParams.get("offset"));
    const all = Array.from({ length: 10 }, (_, i) => tmTag({ id: 7000 + i, dateOfWorkPerformed: `2026-10-0${i % 2 ? 1 : 9}T00:00:00.000Z`, dateOfWorkPerformedAdditional: [] }));
    return envelope(all.slice(offset, offset + limit), 10, offset, limit);
  };
  const h = await harness({ "GET /tags": many }, { cfg: { pageSize: 2 } });
  const r1 = await h.call("list_tm_tags", { work_date_from: "2026-10-01", work_date_until: "2026-10-02", limit: 3 });
  assert.equal(r1.isError, false, r1.text);
  assert.deepEqual(tagIds(r1), [7001, 7003, 7005]);
  assert.equal(r1.json.next_skip, 3);
  assert.equal(r1.json.total_matching, 5);

  const capped = await harness({ "GET /tags": many }, { cfg: { pageSize: 2, maxSubrequests: 3 } });
  const r2 = await capped.call("list_tm_tags", { work_date_from: "2026-10-01" });
  assert.equal(r2.isError, false, r2.text);
  assert.equal(r2.json.scope, "partial");
  assert.equal(r2.json.total_matching, undefined);
});

test("list_tm_tags work date errors name the field; from after until is an error", async () => {
  const h = await harness({ "GET /tags": envelope([]) });
  const bad = await h.call("list_tm_tags", { work_date_until: "10/14/2026" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /work_date_until must be a date as YYYY-MM-DD/);
  const flip = await h.call("list_tm_tags", { work_date_from: "2026-10-31", work_date_until: "2026-10-01" });
  assert.equal(flip.isError, true);
  assert.match(flip.text, /work_date_from \(2026-10-31\) is after work_date_until/);
  assert.equal(h.apiCalls().length, 0);
});
