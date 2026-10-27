import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest } from "./harness.ts";
import { contractDetail, envelope, integrations, projectRecord } from "./fixtures.ts";

const q = (h: { apiCalls: () => { url: string }[] }, i = 0) => new URL(h.apiCalls()[i].url).searchParams;

test("search_jobs by name text returns compact Jobs in Job/GC terms, archived excluded", async () => {
  const h = await harness({ "GET /projects": envelope([projectRecord()]) });
  const r = await h.call("search_jobs", { name: "Route 30" });
  assert.equal(r.isError, false, r.text);
  const p = q(h);
  assert.equal(p.get("searchTitle"), "Route 30");
  assert.equal(p.get("archived"), null, "not asked => Clearstory returns unarchived only");
  assert.equal(r.json.scope, "complete");
  assert.equal(r.json.total_matching, 1);
  assert.equal(r.json.next_skip, undefined);
  assert.deepEqual(r.json.jobs[0], {
    id: 7001, job_number: "23104", name: "Route 30 Sewer Extension", gc: "Turner Construction",
    contract_value: 1250000.46, office: "Main Office", division: "Utilities", start_date: "2026-03-01", end_date: "2026-12-15",
  });
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("search_jobs by job number uses Clearstory's exact jobNumber filter", async () => {
  const h = await harness({ "GET /projects": envelope([projectRecord()]) });
  const r = await h.call("search_jobs", { job_number: " 23104 " });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("jobNumber"), "23104");
  assert.equal(r.json.jobs[0].job_number, "23104");
});

test("search_jobs include_archived also returns archived Jobs", async () => {
  const h = await harness({
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("archived") === "true"
      ? envelope([projectRecord({ id: 7002, jobNumber: "19001", archived: true })])
      : envelope([projectRecord()]),
  });
  const r = await h.call("search_jobs", { include_archived: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.jobs.map((j: { id: number }) => j.id), [7001, 7002]);
  assert.equal(r.json.jobs[1].archived, true);
  assert.equal(r.json.total_matching, 2);
});

test("search_jobs detail adds GC id, GC job number, address and timestamps", async () => {
  const h = await harness({ "GET /projects": envelope([projectRecord()]) });
  const r = await h.call("search_jobs", { detail: true });
  assert.equal(r.isError, false, r.text);
  const j = r.json.jobs[0];
  assert.equal(j.gc_id, 301);
  assert.equal(j.gc_job_number, "T-889");
  assert.equal(j.address, "1 Route 30, Example, PA");
  assert.equal(j.updated_at, "2026-10-20T09:30:00.000Z");
});

const jobRoutes = (over: Record<string, unknown> = {}) => ({
  "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber") === "23104" && req.url.searchParams.get("archived") !== "true"
    ? envelope([projectRecord()]) : envelope([]),
  "GET /projects/7001": projectRecord(),
  "GET /contracts": envelope([contractDetail(), contractDetail({ id: 9002, name: "Change Work", contractValue: 15000.1 })]),
  "GET /projects/7001/integrations": integrations([{ provider: "hcss_heavyjob", externalProjectId: "hj-555" }]),
  ...over,
});

test("get_job by job number shows GC, contracts and integrations", async () => {
  const h = await harness(jobRoutes());
  const r = await h.call("get_job", { job: "23104" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.job_number, "23104");
  assert.equal(r.json.gc, "Turner Construction");
  assert.equal(r.json.contract_value, 1250000.46);
  assert.deepEqual(r.json.contracts, [
    { id: 9001, name: "Prime Sitework", contract_value: 1250000.46 },
    { id: 9002, name: "Change Work", contract_value: 15000.1 },
  ]);
  assert.equal(r.json.integrations.heavyjob, true);
  assert.equal(r.json.integrations.procore, false);
  assert.deepEqual(r.json.integrations.links, [{ system: "hcss_heavyjob", external_job_id: "hj-555", external_job_name: "23104 Route 30" }]);
  const contractsCall = h.apiCalls().find((c) => new URL(c.url).pathname.endsWith("/contracts"))!;
  assert.equal(new URL(contractsCall.url).searchParams.get("projectId"), "7001");
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("get_job by Clearstory id reads /projects/{id}", async () => {
  const h = await harness(jobRoutes({ "GET /projects/7001/integrations": integrations([{ provider: "procore" }]) }));
  const r = await h.call("get_job", { job_id: 7001 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.id, 7001);
  assert.equal(r.json.integrations.heavyjob, false);
  assert.equal(r.json.integrations.procore, true);
  assert.ok(h.apiCalls().some((c) => new URL(c.url).pathname.endsWith("/projects/7001")));
});

test("get_job finds an archived Job by job number", async () => {
  const h = await harness(jobRoutes({
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("archived") === "true"
      ? envelope([projectRecord({ archived: true })]) : envelope([]),
  }));
  const r = await h.call("get_job", { job: "23104" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.archived, true);
});

test("get_job with an unknown job number errors with close matches", async () => {
  const h = await harness(jobRoutes({
    "GET /projects": (req: FakeRequest) => req.url.searchParams.get("jobNumber")
      ? envelope([])
      : envelope([projectRecord(), projectRecord({ id: 7003, jobNumber: "24410", projectTitle: "Mill Creek Bridge" })]),
  }));
  const r = await h.call("get_job", { job: "23140" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No Job with job number '23140'/);
  assert.match(r.text, /23104 Route 30 Sewer Extension/);
  assert.doesNotMatch(r.text, /24410/);
});

test("get_job needs a job number or id", async () => {
  const h = await harness(jobRoutes());
  const r = await h.call("get_job", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /job number/);
});
