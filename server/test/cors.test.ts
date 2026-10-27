import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";
import { corDetail, corLineItems, corRevision, corSent, corTag } from "./fixtures-cors.ts";

type H = { apiCalls: () => { url: string }[] };
const corsCall = (h: H) => new URL(h.apiCalls().find((c) => new URL(c.url).pathname.endsWith("/cors"))!.url).searchParams;

test("list_cors defaults: Sent inbox, Void/Waived excluded, compact CORs in GLOSSARY terms with T&M Tag ids", async () => {
  const h = await harness({ "GET /cors": envelope([corSent()]) });
  const r = await h.call("list_cors", {});
  assert.equal(r.isError, false, r.text);
  const p = corsCall(h);
  assert.equal(p.get("inbox"), "sent");
  assert.equal(p.get("statuses"), "in_review,approved_to_proceed,approved_co_issued,placeholder", "rejected (Void) not asked for");
  assert.equal(p.get("includeFromArchivedProjects"), null);
  assert.equal(r.json.scope, "complete");
  assert.equal(r.json.total_matching, 1);
  assert.deepEqual(r.json.cors[0], {
    id: 6201, cor_number: "COR-017", title: "Rock excavation at MH-4",
    job_id: 7001, job_number: "23104", job_name: "Route 30 Sewer Extension", gc: "Turner Construction", gc_id: 301,
    status: "In Review", stage: "in_review", ball_in_court: "GC",
    requested_amount: 18450.46, in_review_amount: 18450.46, approved_to_proceed_amount: 0, approved_co_issued_amount: 0, void_amount: 0,
    date_submitted: "2026-09-20", days_in_review: 37,
    revision: 2,
    tm_tag_count: 2, tm_tag_ids: [5101, 5102],
  });
  assert.doesNotMatch(JSON.stringify(r.json.cors), /project|customer/i);
});

test("list_cors lists tm_tag_ids even when empty, and flags when Clearstory's tag list is shorter than its count", async () => {
  const h = await harness({ "GET /cors": envelope([
    corSent({ id: 1, tmTagCount: 0, tmTags: [] }),
    corSent({ id: 2, tmTagCount: 3, tmTags: [corTag()] }),
  ]) });
  const r = await h.call("list_cors", {});
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.cors[0].tm_tag_ids, []);
  assert.equal(r.json.cors[0].tm_tags_incomplete, undefined);
  assert.deepEqual(r.json.cors[1].tm_tag_ids, [5101]);
  assert.equal(r.json.cors[1].tm_tags_incomplete, true);
});

test("list_cors include_void asks Clearstory for every status, Void shown with its Waived stage", async () => {
  const h = await harness({ "GET /cors": envelope([corSent({ status: "rejected", stage: "waived", ballInCourt: "na", voidAmount: 500 })]) });
  const r = await h.call("list_cors", { include_void: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(corsCall(h).get("statuses"), null);
  assert.equal(r.json.cors[0].status, "Void");
  assert.equal(r.json.cors[0].stage, "waived");
  assert.equal(r.json.cors[0].ball_in_court, undefined, "na = nobody");
});

test("list_cors statuses filter maps GLOSSARY statuses; asking for Void includes it", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("list_cors", { statuses: ["Approved to Proceed", "Void"] });
  assert.equal(r.isError, false, r.text);
  assert.equal(corsCall(h).get("statuses"), "approved_to_proceed,rejected");
});

test("list_cors stages void/waived counts as asking for Void", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("list_cors", { stages: ["waived"] });
  assert.equal(r.isError, false, r.text);
  const p = corsCall(h);
  assert.equal(p.get("stages"), "waived");
  assert.equal(p.get("statuses"), null);
});

test("list_cors Received inbox on request; Ball in Court company = Schreiber", async () => {
  const h = await harness({ "GET /cors": envelope([corSent({ ballInCourt: "company" })]) });
  const r = await h.call("list_cors", { inbox: "received" });
  assert.equal(r.isError, false, r.text);
  assert.equal(corsCall(h).get("inbox"), "received");
  assert.equal(r.json.cors[0].ball_in_court, "Schreiber");
});

test("list_cors for a Job number filters by the Job's id (Sent) and errors on an unknown Job", async () => {
  const routes = {
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber") === "23104" && req.url.searchParams.get("archived") !== "true"
      ? envelope([projectRecord()]) : envelope([]),
    "GET /cors": envelope([corSent()]),
  };
  const h = await harness(routes);
  const r = await h.call("list_cors", { job: "23104" });
  assert.equal(r.isError, false, r.text);
  assert.equal(corsCall(h).get("projectIds"), "7001");

  const bad = await (await harness(routes)).call("list_cors", { job: "99999" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /No Job with job number '99999'/);
});

test("list_cors for a Job in the Received inbox filters by our job number (Clearstory's projectId is the sender's)", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("list_cors", { inbox: "received", job: "23104" });
  assert.equal(r.isError, false, r.text);
  const p = corsCall(h);
  assert.equal(p.get("companyJobNumber"), "23104");
  assert.equal(p.get("projectIds"), null);
});

test("list_cors passes GC, labels, has T&M Tags, archived-Job and sort filters", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("list_cors", {
    job_id: 7001, gc_id: 301, label_ids: [81, 82], has_tm_tags: true, include_archived_jobs: true, sort_by: "days_in_review",
  });
  assert.equal(r.isError, false, r.text);
  const p = corsCall(h);
  assert.equal(p.get("projectIds"), "7001");
  assert.equal(p.get("customerIds"), "301");
  assert.equal(p.get("labelIds"), "81,82");
  assert.equal(p.get("hasTags"), "1");
  assert.equal(p.get("includeFromArchivedProjects"), "true");
  assert.equal(p.get("sortBy"), "daysInReview");
  assert.equal(p.get("sortDirection"), "desc");
  assert.equal(h.apiCalls().length, 1, "job_id needs no lookup");
});

test("list_cors date ranges go to Clearstory as start/end of day UTC", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("list_cors", {
    submitted_from: "2026-09-01", submitted_until: "2026-09-30",
    co_issued_from: "2026-10-01", co_issued_until: "2026-10-01",
    updated_from: "2026-10-15", updated_until: "2026-10-27",
  });
  assert.equal(r.isError, false, r.text);
  const p = corsCall(h);
  assert.equal(p.get("fromDateSubmitted"), "2026-09-01T00:00:00.000Z");
  assert.equal(p.get("untilDateSubmitted"), "2026-09-30T23:59:59.999Z");
  assert.equal(p.get("fromCOIssueDate"), "2026-10-01T00:00:00.000Z");
  assert.equal(p.get("untilCOIssueDate"), "2026-10-01T23:59:59.999Z");
  assert.equal(p.get("fromUpdatedAt"), "2026-10-15T00:00:00.000Z");
  assert.equal(p.get("untilUpdatedAt"), "2026-10-27T23:59:59.999Z");
});

test("list_cors bad dates error naming the field, before any Clearstory call", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const bad = await h.call("list_cors", { co_issued_from: "10/01/2026" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /co_issued_from must be a date as YYYY-MM-DD/);
  const flipped = await h.call("list_cors", { updated_from: "2026-10-27", updated_until: "2026-10-01" });
  assert.equal(flipped.isError, true);
  assert.match(flipped.text, /updated_from \(2026-10-27\) is after updated_until \(2026-10-01\)/);
  assert.equal(h.apiCalls().length, 0);
});

test("list_cors reason category filters by name (Clearstory has no such filter) and keeps paging honest", async () => {
  const all = [
    corSent({ id: 1 }),
    corSent({ id: 2, reasonCategory: { id: "rc-2", name: "Owner Request", reasonCategoryGroup: { id: "rg-2", name: "Owner" } } }),
    corSent({ id: 3 }),
    corSent({ id: 4, reasonCategory: null }),
    corSent({ id: 5 }),
  ];
  const h = await harness({
    "GET /cors": (req: FakeRequest) => {
      const o = Number(req.url.searchParams.get("offset")), l = Number(req.url.searchParams.get("limit"));
      return envelope(all.slice(o, o + l), all.length, o, l);
    },
  }, { cfg: { pageSize: 2 } });
  const r1 = await h.call("list_cors", { reason_category: "differing site", limit: 2 });
  assert.equal(r1.isError, false, r1.text);
  assert.deepEqual(r1.json.cors.map((c: { id: number }) => c.id), [1, 3]);
  assert.equal(r1.json.total_matching, 3);
  assert.equal(r1.json.next_skip, 2);
  const r2 = await h.call("list_cors", { reason_category: "differing site", limit: 2, skip: 2 });
  assert.deepEqual(r2.json.cors.map((c: { id: number }) => c.id), [5]);
  assert.equal(r2.json.next_skip, undefined);
});

test("list_cors detail adds labels, reason category, dates, GC numbers, revision chain and the tags' status", async () => {
  const h = await harness({ "GET /cors": envelope([corSent({ coIssueDate: "2026-10-05T00:00:00.000Z", customerCoNumber: "CO-9" })]) });
  const r = await h.call("list_cors", { detail: true });
  assert.equal(r.isError, false, r.text);
  const c = r.json.cors[0];
  assert.deepEqual(c.labels, ["Rock"]);
  assert.equal(c.reason_category, "Differing Site Condition");
  assert.equal(c.reason_category_group, "Field");
  assert.equal(c.co_issue_date, "2026-10-05");
  assert.equal(c.gc_co_number, "CO-9");
  assert.equal(c.gc_reference_number, "PCO-88");
  assert.equal(c.original_cor_id, 6200);
  assert.equal(c.updated_at, "2026-10-01T08:00:00.000Z");
  assert.deepEqual(c.tm_tags[0], {
    id: 5101, number: "0041", title: "Extra trench rock", status: "signed", work_date: "2026-09-14", signed_on: "2026-09-16", total_hours: 12.3333,
  });
});

// ---- get_cor ----

test("get_cor returns description, Ball in Court, Days in Review, hours ST/OT/DT, LMEO line items and T&M Tags", async () => {
  const h = await harness({ "GET /cors/6201": corDetail() });
  const r = await h.call("get_cor", { id: 6201 });
  assert.equal(r.isError, false, r.text);
  const c = r.json;
  assert.equal(c.cor_number, "COR-017");
  assert.equal(c.description, "Rock encountered at MH-4 below design grade; hammered and hauled off.");
  assert.equal(c.ball_in_court, "GC");
  assert.equal(c.days_in_review, 37);
  assert.equal(c.status, "In Review");
  assert.deepEqual(c.hours, { st: 10.1235, ot: 8.5, dt: 0, total: 18.6235 });
  assert.deepEqual(c.line_items.labor, [{ description: "Operator", internal_id: "OP1", quantity: 10.1235, unit: "HR", rate: 95.56, total: 967.34 }]);
  assert.equal(c.line_items.materials[0].description, "#57 stone");
  assert.equal(c.line_items.equipment[0].total, 1680);
  assert.equal(c.line_items.other[0].description, "Disposal fee");
  assert.deepEqual(c.line_items.markups, [{ description: "OH&P", applies_to: "labor", rate: 15, rate_type: "percent", total: 145.1 }]);
  assert.deepEqual(c.tm_tag_ids, [5101, 5102]);
  assert.equal(c.tm_tags[1].number, "0042");
  assert.equal(c.revisions, undefined, "revisions only on detail");
  assert.deepEqual(h.apiCalls().map((x) => new URL(x.url).pathname.replace(/.*\/v1/, "")), ["/cors/6201"]);
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("get_cor fetches line items when Clearstory did not embed them", async () => {
  const h = await harness({ "GET /cors/6201": corDetail({ lineItems: null }), "GET /cors/6201/line-items": corLineItems({ labor: [] }) });
  const r = await h.call("get_cor", { id: 6201 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.line_items.labor, []);
  assert.equal(r.json.line_items.materials.length, 1);
});

test("get_cor detail adds the revision history", async () => {
  const h = await harness({
    "GET /cors/6201": corDetail(),
    "GET /cors/6201/revisions": envelope([
      corRevision({ id: 6200, version: 1, isLatestVersion: false, requestedAmount: 15000, dateSubmitted: "2026-09-01T12:00:00.000Z", status: "in_review" }),
      corRevision(),
    ]),
  });
  const r = await h.call("get_cor", { id: 6201, detail: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.revisions, [
    { id: 6200, revision: 1, latest: false, status: "In Review", requested_amount: 15000, date_submitted: "2026-09-01", updated_at: "2026-10-01T08:00:00.000Z" },
    { id: 6201, revision: 2, latest: true, status: "In Review", requested_amount: 18450.46, date_submitted: "2026-09-20", updated_at: "2026-10-01T08:00:00.000Z" },
  ]);
  assert.equal(r.json.labels[0], "Rock");
});

test("get_cor not found passes Clearstory's error through", async () => {
  const h = await harness({});
  const r = await h.call("get_cor", { id: 404404 });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 404/);
});
