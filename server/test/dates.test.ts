// Date input helper shared by list tools with date filters (tickets #3, #5, #6). Tested directly because
// no ticket-#2 tool takes dates; tool-level tests in those tickets cover the query sent to Clearstory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateRange } from "../src/dates.ts";

test("from → start of day UTC, until → end of day UTC", () => {
  assert.deepEqual(dateRange({ submitted_from: "2026-09-01", submitted_until: "2026-09-30" }, "submitted_from", "submitted_until"),
    { from: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" });
});

test("either end may be left out; the same day for both is allowed", () => {
  assert.deepEqual(dateRange({ from: "2026-02-28" }, "from", "until"), { from: "2026-02-28T00:00:00.000Z" });
  assert.deepEqual(dateRange({ until: "2024-02-29" }, "from", "until"), { until: "2024-02-29T23:59:59.999Z" });
  assert.deepEqual(dateRange({}, "from", "until"), {});
  assert.deepEqual(dateRange({ from: "2026-05-01", until: "2026-05-01" }, "from", "until"),
    { from: "2026-05-01T00:00:00.000Z", until: "2026-05-01T23:59:59.999Z" });
});

for (const bad of ["2026-9-01", "09/01/2026", "2026-02-30", "2026-13-01", "2025-02-29", "2026-09-01T00:00:00Z", "yesterday", ""]) {
  test(`'${bad}' is rejected with an error naming the field`, () => {
    assert.throws(() => dateRange({ updated_until: bad }, "updated_from", "updated_until"),
      (e: Error) => /updated_until/.test(e.message) && /YYYY-MM-DD/.test(e.message));
  });
}

test("from after until is an error naming both fields", () => {
  assert.throws(() => dateRange({ work_from: "2026-05-02", work_until: "2026-05-01" }, "work_from", "work_until"),
    /work_from \(2026-05-02\) is after work_until \(2026-05-01\)/);
});
