import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.ts";
import { envelope } from "./fixtures.ts";
import { cnCor, cnReceived, cnSent, daysFromNow } from "./fixtures-notifications.ts";

const q = (h: { apiCalls: () => { url: string }[] }, i = 0) => new URL(h.apiCalls()[i].url).searchParams;

test("list_change_notifications defaults to the Received inbox and shows type, due date, responded, overdue", async () => {
  const due = daysFromNow(-3);
  const h = await harness({ "GET /change-notifications": envelope([cnReceived({}, { dueDate: due })]) });
  const r = await h.call("list_change_notifications");
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("inbox"), "received");
  assert.equal(r.json.inbox, "Received");
  assert.deepEqual(r.json.change_notifications[0], {
    id: 5501, contract_id: 9001, job_id: 7001, gc: "Turner Construction", gc_reference: "CN-22",
    type: "Pricing Request", title: "Price added rock removal at MH-4",
    received: "2026-10-01", due_date: due.slice(0, 10), responded: false, overdue: true,
  });
  assert.equal(r.json.overdue_count, 1);
  assert.doesNotMatch(r.text, /project|customer|RFI/i);
});

test("overdue only when the due date has passed and Schreiber has not responded; responded items show the linked COR", async () => {
  const h = await harness({ "GET /change-notifications": envelope([
    cnReceived({ contractId: 1 }, { id: 1, dueDate: daysFromNow(-2) }), // past, unanswered → overdue
    cnReceived({ contractId: 2 }, { id: 2, dueDate: daysFromNow(2) }), // future, unanswered
    cnReceived({ contractId: 3, hasResponded: true, cor: cnCor() }, { id: 3, dueDate: daysFromNow(-2) }), // past, answered
    cnReceived({ contractId: 4 }, { id: 4, dueDate: null }), // no due date
  ]) });
  const r = await h.call("list_change_notifications", {});
  assert.equal(r.isError, false, r.text);
  const by = Object.fromEntries(r.json.change_notifications.map((c: { id: number }) => [c.id, c]));
  assert.deepEqual([1, 2, 3, 4].map((i) => by[i].overdue), [true, false, false, false]);
  assert.equal(r.json.overdue_count, 1);
  assert.equal(by[3].responded, true);
  assert.deepEqual(by[3].cor, { number: "COR-014", title: "Extra rock excavation", status: "In Review", total: 18450.56, submitted: "2026-10-05" });
  assert.equal(by[1].cor, undefined);
});

test("a Void (rejected) linked COR is shown as Void, Waived noted", async () => {
  const h = await harness({ "GET /change-notifications": envelope([
    cnReceived({ hasResponded: true, cor: cnCor({ status: "rejected", stage: "waived" }) }),
  ]) });
  const r = await h.call("list_change_notifications");
  assert.equal(r.json.change_notifications[0].cor.status, "Void");
  assert.equal(r.json.change_notifications[0].cor.void_kind, "Waived");
});

test("filters: type, Job (by job number), due and submitted ranges sent to Clearstory as UTC", async () => {
  const h = await harness({
    "GET /projects": envelope([{ id: 7001, jobNumber: "23104", projectTitle: "Route 30 Sewer Extension" }]),
    "GET /change-notifications": envelope([]),
  });
  const r = await h.call("list_change_notifications", {
    type: "Authorize T&M Work", job: "23104",
    due_from: "2026-10-01", due_until: "2026-10-31", submitted_from: "2026-09-01", submitted_until: "2026-09-30",
  });
  assert.equal(r.isError, false, r.text);
  const p = new URL(h.apiCalls().find((c) => c.url.includes("/change-notifications"))!.url).searchParams;
  assert.equal(p.get("inbox"), "received");
  assert.equal(p.get("types"), "authorize_tm_work");
  assert.equal(p.get("projectIds"), "7001");
  assert.equal(p.get("fromDueDate"), "2026-10-01T00:00:00.000Z");
  assert.equal(p.get("untilDueDate"), "2026-10-31T23:59:59.999Z");
  assert.equal(p.get("fromDateSubmitted"), "2026-09-01T00:00:00.000Z");
  assert.equal(p.get("untilDateSubmitted"), "2026-09-30T23:59:59.999Z");
});

test("bad dates are rejected naming the field, before any Clearstory call", async () => {
  const h = await harness({ "GET /change-notifications": envelope([]) });
  const bad = await h.call("list_change_notifications", { due_until: "10/31/2026" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /due_until.*YYYY-MM-DD/);
  const order = await h.call("list_change_notifications", { submitted_from: "2026-10-02", submitted_until: "2026-10-01" });
  assert.equal(order.isError, true);
  assert.match(order.text, /submitted_from \(2026-10-02\) is after submitted_until \(2026-10-01\)/);
  assert.equal(h.apiCalls().length, 0);
});

test("Sent inbox lists Change Notifications Schreiber sent, with responses counted toward overdue", async () => {
  const h = await harness({ "GET /change-notifications": envelope([cnSent()]) });
  const r = await h.call("list_change_notifications", { inbox: "Sent" });
  assert.equal(r.isError, false, r.text);
  assert.equal(q(h).get("inbox"), "sent");
  const c = r.json.change_notifications[0];
  assert.equal(c.type, "Authorize T&M Work");
  assert.equal(c.job_number, "23104");
  assert.equal(c.responded, false);
  assert.equal(c.responded_count, "1 of 2");
  assert.equal(c.overdue, true);
  assert.doesNotMatch(r.text, /project|customer/i);
});

test("get_change_notification (Received) reads the contract view and shows the linked COR in full", async () => {
  const h = await harness({ "GET /change-notifications/5501/9001": cnReceived({ hasResponded: true, cor: cnCor({ status: "approved_co_issued", coIssueDate: "2026-10-20" }) }) });
  const r = await h.call("get_change_notification", { id: 5501, contract_id: 9001 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.id, 5501);
  assert.equal(r.json.type, "Pricing Request");
  assert.equal(r.json.gc, "Turner Construction");
  assert.equal(r.json.description, "Rock encountered at MH-4; price removal.");
  assert.equal(r.json.sent_by, "Pat Doe");
  assert.equal(r.json.contract, "Prime Sitework");
  assert.equal(r.json.responded, true);
  assert.equal(r.json.overdue, false);
  assert.equal(r.json.cor.status, "Approved CO Issued");
  assert.equal(r.json.cor.co_issued, "2026-10-20");
  assert.doesNotMatch(r.text, /project|customer|RFI/i);
});

test("get_change_notification (Received) without contract_id explains where to find it", async () => {
  const h = await harness({});
  const r = await h.call("get_change_notification", { id: 5501 });
  assert.equal(r.isError, true);
  assert.match(r.text, /contract_id.*list_change_notifications/);
  assert.equal(h.apiCalls().length, 0);
});

test("get_change_notification (Sent) shows each sub's reply and COR", async () => {
  const h = await harness({ "GET /change-notifications/6601": cnSent() });
  const r = await h.call("get_change_notification", { id: 6601, inbox: "Sent" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.overdue, true);
  assert.deepEqual(r.json.replies.map((x: { contract_id: number; responded: boolean }) => [x.contract_id, x.responded]), [[9101, true], [9102, false]]);
  assert.equal(r.json.replies[0].cor.number, "P-3");
});
