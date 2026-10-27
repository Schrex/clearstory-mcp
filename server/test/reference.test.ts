import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, type FakeRequest } from "./harness.ts";
import { envelope, projectRecord } from "./fixtures.ts";
import {
  customerDetail, customerRecord, divisionRecord, equipmentRate, labelRecord, laborRate, materialRate, officeRecord, projectLaborRate,
  reasonCategory, reasonCategoryList, userRecord,
}from "./fixtures-reference.ts";

const paths = (h: { apiCalls: () => { url: string }[] }) => h.apiCalls().map((c) => new URL(c.url).pathname.replace(/.*\/v1/, ""));
const q = (h: { apiCalls: () => { url: string }[] }, i = 0) => new URL(h.apiCalls()[i].url).searchParams;

// ---- list_offices ----

test("list_offices returns compact offices with paging, plus the company's divisions", async () => {
  const h = await harness({
    "GET /offices": envelope([officeRecord(), officeRecord({ id: 13, name: "North Yard", customId: "NORTH" })], 3),
    "GET /divisions": envelope([divisionRecord("Utilities"), divisionRecord("Sitework")]),
  });
  const r = await h.call("list_offices", { limit: 2 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.total_matching, 3);
  assert.equal(r.json.next_skip, 2);
  assert.equal(r.json.scope, "complete");
  assert.deepEqual(r.json.offices, [
    { id: 12, name: "Main Office", code: "MAIN", city: "Example", state: "PA" },
    { id: 13, name: "North Yard", code: "NORTH", city: "Example", state: "PA" },
  ]);
  assert.deepEqual(r.json.divisions, ["Utilities", "Sitework"]);
  assert.equal(q(h).get("sortBy"), "name");
});

test("list_offices detail adds address, phone and time zone", async () => {
  const h = await harness({ "GET /offices": envelope([officeRecord()]), "GET /divisions": envelope([]) });
  const r = await h.call("list_offices", { detail: true });
  assert.equal(r.isError, false, r.text);
  const o = r.json.offices[0];
  assert.equal(o.address, "1000 Example Rd");
  assert.equal(o.phone, "555-0100");
  assert.equal(o.time_zone, "America/New_York");
  assert.deepEqual(paths(h).sort(), ["/divisions", "/offices"]);
});

// ---- list_gcs ----

test("list_gcs searches GCs by name and returns compact GC records with paging, never 'customer'", async () => {
  const h = await harness({ "GET /customers": envelope([customerRecord()], 4) });
  const r = await h.call("list_gcs", { name: " Turner ", limit: 1 });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("searchName"), "Turner");
  assert.equal(q(h).get("sortBy"), "name");
  assert.equal(r.json.total_matching, 4);
  assert.equal(r.json.next_skip, 1);
  assert.deepEqual(r.json.gcs, [{ id: 301, name: "Turner Construction", internal_id: "TURN", city: "New York", state: "NY" }]);
  assert.doesNotMatch(r.text, /customer/i);
});

test("list_gcs filters by office and internal id", async () => {
  const h = await harness({ "GET /customers": envelope([]) });
  const r = await h.call("list_gcs", { office_id: 12, internal_id: "TURN" });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("officeId"), "12");
  assert.equal(q(h).get("internalId"), "TURN");
  assert.deepEqual(r.json.gcs, []);
});

test("list_gcs detail adds address and phone", async () => {
  const h = await harness({ "GET /customers": envelope([customerRecord()]) });
  const r = await h.call("list_gcs", { detail: true });
  assert.equal(r.json.gcs[0].address, "375 Hudson St");
  assert.equal(r.json.gcs[0].phone, "555-0200");
});

test("list_gcs with gc_id returns that one GC in full, with its offices", async () => {
  const h = await harness({ "GET /customers/301": customerDetail() });
  const r = await h.call("list_gcs", { gc_id: 301 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.gc.name, "Turner Construction");
  assert.equal(r.json.gc.zip, "10014");
  assert.deepEqual(r.json.gc.offices, [{ id: 12, name: "Main Office", code: "MAIN", city: "Example", state: "PA" }]);
  assert.doesNotMatch(r.text, /customer/i);
});

// ---- list_rates ----

test("list_rates labor, company-wide: compact labor classes with ST/OT/DT rates and paging", async () => {
  const h = await harness({ "GET /rates/labor": envelope([laborRate()], 30) });
  const r = await h.call("list_rates", { type: "labor", limit: 1 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(paths(h), ["/rates/labor"]);
  assert.equal(r.json.level, "company");
  assert.equal(r.json.type, "labor");
  assert.equal(r.json.total_matching, 30);
  assert.equal(r.json.next_skip, 1);
  assert.deepEqual(r.json.rates, [{
    id: 501, internal_id: "OP-1", name: "Operator Class 1", st: 95.51, ot: 130.25, dt: 165, premium_ot: 140, premium_dt: 175, rate_group: "Union 2026",
  }]);
});

test("list_rates equipment and material: name, unit and rate", async () => {
  const h = await harness({ "GET /rates/equipment": envelope([equipmentRate()]), "GET /rates/material": envelope([materialRate()]) });
  const e = await h.call("list_rates", { type: "equipment" });
  assert.deepEqual(e.json.rates, [{ id: 601, internal_id: "EX-320", name: "CAT 320 Excavator", unit: "hr", rate: 185, rate_group: "Union 2026" }]);
  const m = await h.call("list_rates", { type: "material", rate_group_id: 4, internal_id: "STONE-2A" });
  assert.deepEqual(m.json.rates, [{ id: 701, internal_id: "STONE-2A", name: "2A Modified Stone", unit: "ton", rate: 28.5, rate_group: "Union 2026" }]);
  const p = q(h, 1);
  assert.equal(p.get("rateGroupId"), "4");
  assert.equal(p.get("internalId"), "STONE-2A");
});

test("list_rates per Job takes a job number and reads that Job's rates", async () => {
  const h = await harness({
    "GET /projects": (req: FakeRequest) => (req.url.searchParams.get("archived") !== "true" ? envelope([projectRecord()]) : envelope([])),
    "GET /rates/project/7001/labor": envelope([projectLaborRate()]),
  });
  const r = await h.call("list_rates", { type: "labor", job: "23104" });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("jobNumber"), "23104");
  assert.equal(r.json.level, "job");
  assert.equal(r.json.job_id, 7001);
  assert.deepEqual(r.json.rates, [{ id: 8801, internal_id: "OP-1", name: "Operator Class 1", st: 99, ot: 135, dt: 170, company_rate_id: 501 }]);
  assert.doesNotMatch(r.text, /project/i);
});

test("list_rates per Job by job_id skips the lookup; detail shows whether it follows company rate changes", async () => {
  const h = await harness({ "GET /rates/project/7001/labor": envelope([projectLaborRate()]) });
  const r = await h.call("list_rates", { type: "labor", job_id: 7001, detail: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(paths(h), ["/rates/project/7001/labor"]);
  assert.equal(r.json.rates[0].follows_company_rate, false);
  assert.equal(r.json.rates[0].updated_at, "2026-03-02T00:00:00.000Z");
});

// ---- list_reference ----

test("list_reference labels: compact labels with paging", async () => {
  const h = await harness({ "GET /labels": envelope([labelRecord(), labelRecord({ id: 42, name: "Old", active: false, companyStandard: false })], 5) });
  const r = await h.call("list_reference", { kind: "labels", limit: 2 });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("sortBy"), "name");
  assert.equal(r.json.total_matching, 5);
  assert.equal(r.json.next_skip, 2);
  assert.deepEqual(r.json.labels, [{ id: 41, name: "Rock", active: true }, { id: 42, name: "Old", active: false }]);
});

test("list_reference reason categories: Clearstory returns them unpaged; the tool pages them itself", async () => {
  const h = await harness({
    "GET /reason-categories": reasonCategoryList([
      reasonCategory(), reasonCategory({ id: "rc-2", name: "Unforeseen Conditions" }), reasonCategory({ id: "rc-3", name: "Design Error", isArchived: true }),
    ]),
  });
  const r = await h.call("list_reference", { kind: "reason_categories", skip: 1, limit: 1 });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("limit"), null, "no paging params sent to an unpaged endpoint");
  assert.equal(r.json.total_matching, 3);
  assert.equal(r.json.skip, 1);
  assert.equal(r.json.next_skip, 2);
  assert.deepEqual(r.json.reason_categories, [{ id: "rc-2", name: "Unforeseen Conditions", group: "Owner" }]);
  const last = await h.call("list_reference", { kind: "reason_categories", skip: 2 });
  assert.deepEqual(last.json.reason_categories, [{ id: "rc-3", name: "Design Error", group: "Owner", archived: true }]);
  assert.equal(last.json.next_skip, undefined);
});

test("list_reference users: compact users, filtered by office, Job and email", async () => {
  const h = await harness({
    "GET /projects": (req: FakeRequest) => (req.url.searchParams.get("archived") !== "true" ? envelope([projectRecord()]) : envelope([])),
    "GET /users": envelope([userRecord()]),
  });
  const r = await h.call("list_reference", { kind: "users", office_id: 12, job: "23104", email: "pm@schrex.com" });
  assert.equal(r.isError, false, r.text);
  const p = q(h, 1);
  assert.equal(p.get("officeId"), "12");
  assert.equal(p.get("projectId"), "7001");
  assert.equal(p.get("email"), "pm@schrex.com");
  assert.deepEqual(r.json.users, [{ id: 77, name: "Pat Miller", email: "pm@schrex.com", role: "Project Manager", offices: ["Main Office"] }]);});

test("list_reference detail adds timestamps", async () => {
  const h = await harness({ "GET /labels": envelope([labelRecord()]) });
  const r = await h.call("list_reference", { kind: "labels", detail: true });
  assert.equal(r.json.labels[0].company_standard, true);
  assert.equal(r.json.labels[0].updated_at, "2026-01-01T00:00:00.000Z");
});

test("list_rates rejects an unknown rate type", async () => {
  const h = await harness({});
  const r = await h.call("list_rates", { type: "fuel" });
  assert.equal(r.isError, true);
  assert.equal(h.apiCalls().length, 0);
});
