import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";
import { corSent } from "./fixtures-cors.ts";
import { contractSummary, corOverview, inReviewCor } from "./fixtures-summary.ts";

type H = { apiCalls: () => { url: string }[] };
const params = (h: H, path: string) =>
  h.apiCalls().filter((c) => new URL(c.url).pathname.endsWith(path)).map((c) => new URL(c.url).searchParams);

test("get_cor_log_summary: $ and counts by status, average Days in Review, Exposure = In Review + Approved to Proceed, Void excluded", async () => {
  const h = await harness({ "GET /cors/overview": corOverview() });
  const r = await h.call("get_cor_log_summary", {});
  assert.equal(r.isError, false, r.text);
  const [p] = params(h, "/cors/overview");
  assert.equal(p.get("inbox"), "sent");
  assert.equal(p.get("statuses"), "in_review,approved_to_proceed,approved_co_issued,placeholder", "Void not asked for");
  assert.equal(r.json.exposure, 57500.62);
  assert.deepEqual(r.json.by_status, {
    "In Review": { count: 3, amount: 42000.12 },
    "Approved to Proceed": { count: 2, amount: 15500.5 },
    "Approved CO Issued": { count: 4, amount: 88000 },
  });
  assert.equal(r.json.cor_count, 9);
  assert.equal(r.json.average_days_in_review, 21.5);
  assert.equal(r.json.scope, "complete");
  assert.doesNotMatch(r.text, /Void|rejected/);
});

test("get_cor_log_summary for a Job: filters by the Job's id and gives totals per contract (Void left out)", async () => {
  const two = [
    { id: 9001, name: "Prime Sitework", contractValue: 1250000.456, contractorProjectId: 7001, customerProjectId: 8001 },
    { id: 9002, name: "Storm Addendum", contractValue: 80000, contractorProjectId: 7001, customerProjectId: 8001 },
  ];
  const h = await harness({
    "GET /projects": envelope([projectRecord({ contracts: two })]),
    "GET /cors/overview": corOverview(),
    "GET /cors/contract-summary": (req: { url: URL }) => req.url.searchParams.get("contractIds") === "9002"
      ? contractSummary({ in_review: 1000, approved_to_proceed: 0, approved_co_issued: 0 }, { originalContractValue: 80000, pendingContractValue: 81000 })
      : contractSummary(),
  });
  const r = await h.call("get_cor_log_summary", { job: "23104" });
  assert.equal(r.isError, false, r.text);
  assert.equal(params(h, "/cors/overview")[0].get("projectIds"), "7001");
  const cs = params(h, "/cors/contract-summary");
  assert.deepEqual(cs.map((p) => [p.get("inbox"), p.get("projectIds"), p.get("contractIds")]), [["sent", "7001", "9001"], ["sent", "7001", "9002"]]);
  assert.equal(r.json.job_number, "23104");
  assert.deepEqual(r.json.contracts, [
    { contract_id: 9001, contract: "Prime Sitework", original_contract_value: 1250000.46, pending_contract_value: 1307500.62, exposure: 57500.62,
      by_status_amount: { "In Review": 42000.12, "Approved to Proceed": 15500.5, "Approved CO Issued": 88000 } },
    { contract_id: 9002, contract: "Storm Addendum", original_contract_value: 80000, pending_contract_value: 81000, exposure: 1000,
      by_status_amount: { "In Review": 1000, "Approved to Proceed": 0, "Approved CO Issued": 0 } },
  ]);
  assert.doesNotMatch(r.text, /Void|rejected/);
});

test("get_cor_aging buckets In Review CORs at 14/15, 30/31, 60/61 days and flags Stale only above 30", async () => {
  const asOf = "2026-10-27";
  const days = [14, 15, 30, 31, 60, 61];
  const h = await harness({ "GET /cors": envelope(days.map((d) => inReviewCor(d, asOf, d))) });
  const r = await h.call("get_cor_aging", { as_of: asOf });
  assert.equal(r.isError, false, r.text);
  const cors = r.json.gcs[0].cors as Record<string, unknown>[];
  const got = Object.fromEntries(cors.map((c) => [c.id, [c.days_in_review, c.bucket, c.stale]]));
  assert.deepEqual(got, {
    14: [14, "0-14", false], 15: [15, "15-30", false],
    30: [30, "15-30", false], 31: [31, "31-60", true],
    60: [60, "31-60", true], 61: [61, "60+", true],
  });
  assert.deepEqual(r.json.buckets, {
    "0-14": { count: 1, amount: 1000 }, "15-30": { count: 2, amount: 2000 }, "31-60": { count: 2, amount: 2000 }, "60+": { count: 1, amount: 1000 },
  });
  assert.deepEqual(r.json.stale, { count: 3, amount: 3000 });
  assert.equal(r.json.as_of, asOf);
});

test("get_cor_aging groups by GC with Ball in Court and Exposure per GC (In Review + Approved to Proceed), Void not asked for", async () => {
  const asOf = "2026-10-27";
  const turner = { id: 301, name: "Turner Construction" };
  const skanska = { id: 302, name: "Skanska" };
  const h = await harness({ "GET /cors": envelope([
    inReviewCor(1, asOf, 40, { customer: turner, inReviewAmount: 5000.111, ballInCourt: "customer" }),
    inReviewCor(2, asOf, 5, { customer: turner, inReviewAmount: 2000, ballInCourt: "company" }),
    corSent({ id: 3, customer: turner, status: "approved_to_proceed", stage: "approved_to_proceed", inReviewAmount: 0, approvedToProceedAmount: 7000 }),
    inReviewCor(4, asOf, 90, { customer: skanska, inReviewAmount: 30000, ballInCourt: "customer" }),
  ]) });
  const r = await h.call("get_cor_aging", { as_of: asOf });
  assert.equal(r.isError, false, r.text);
  const p = params(h, "/cors")[0];
  assert.equal(p.get("inbox"), "sent");
  assert.equal(p.get("statuses"), "in_review,approved_to_proceed", "Void (rejected) never pulled");
  assert.equal(r.json.exposure, 44000.11);
  assert.deepEqual(r.json.in_review, { count: 3, amount: 37000.11 });
  assert.deepEqual(r.json.gcs.map((g: Record<string, unknown>) => [g.gc, g.gc_id, g.exposure, g.in_review_amount, g.approved_to_proceed_amount, g.stale_count, g.ball_in_court]), [
    ["Skanska", 302, 30000, 30000, 0, 1, { GC: 1 }],
    ["Turner Construction", 301, 14000.11, 7000.11, 7000, 1, { GC: 1, Schreiber: 1 }],
  ]);
  const turnerCors = r.json.gcs[1].cors;
  assert.deepEqual(turnerCors.map((c: Record<string, unknown>) => [c.id, c.ball_in_court, c.stale]), [[1, "GC", true], [2, "Schreiber", false]], "oldest first; ATP COR not aged");
  assert.doesNotMatch(r.text, /customer|project/i);
});

test("get_cor_aging for a Job or GC filters the pull; archived Jobs only on request", async () => {
  const h = await harness({ "GET /projects": envelope([projectRecord()]), "GET /cors": envelope([]) });
  const r = await h.call("get_cor_aging", { job: "23104", gc_id: 301, include_archived_jobs: true, as_of: "2026-10-27" });
  assert.equal(r.isError, false, r.text);
  const p = params(h, "/cors")[0];
  assert.equal(p.get("projectIds"), "7001");
  assert.equal(p.get("customerIds"), "301");
  assert.equal(p.get("includeFromArchivedProjects"), "true");
  assert.equal(r.json.exposure, 0);
  assert.deepEqual(r.json.gcs, []);
});

test("get_cor_aging marks totals scope: partial when the pull hits the request limit", async () => {
  const page = (req: { url: URL }) => {
    const off = Number(req.url.searchParams.get("offset"));
    return envelope([inReviewCor(off + 1, "2026-10-27", 10)], 500, off, 1);
  };
  const h = await harness({ "GET /cors": page }, { cfg: { pageSize: 1, maxSubrequests: 3 } });
  const r = await h.call("get_cor_aging", { as_of: "2026-10-27" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.scope, "partial");
  assert.ok(r.json.in_review.count < 500);
  assert.match(r.json.note, /incomplete/);
});

test("get_cor_aging rejects a bad as_of naming the field", async () => {
  const h = await harness({ "GET /cors": envelope([]) });
  const r = await h.call("get_cor_aging", { as_of: "10/27/2026" });
  assert.equal(r.isError, true);
  assert.match(r.text, /as_of/);
});

test("get_cor_log_summary for one contract or one GC passes the filter through", async () => {
  const h = await harness({ "GET /cors/overview": corOverview(), "GET /cors/contract-summary": contractSummary() });
  const r = await h.call("get_cor_log_summary", { contract_id: 9001 });
  assert.equal(r.isError, false, r.text);
  assert.equal(params(h, "/cors/overview")[0].get("contractIds"), "9001");
  assert.equal(params(h, "/cors/contract-summary")[0].get("contractIds"), "9001");
  assert.equal(r.json.contracts.length, 1);
  assert.equal(r.json.contracts[0].exposure, 57500.62);

  const g = await harness({ "GET /cors/overview": corOverview() });
  const rg = await g.call("get_cor_log_summary", { gc_id: 301 });
  assert.equal(rg.isError, false, rg.text);
  assert.equal(params(g, "/cors/overview")[0].get("customerIds"), "301");
  assert.equal(params(g, "/cors/contract-summary").length, 0, "no per-contract totals across all Jobs");
  assert.equal(rg.json.contracts, undefined);
});
