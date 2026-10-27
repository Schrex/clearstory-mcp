import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.ts";
import { company } from "./fixtures.ts";

test("get_company returns the company name and id", async () => {
  const h = await harness({ "GET /company": company });
  const r = await h.call("get_company");
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json, { id: 4821, name: "Schreiber Excavating, Inc." });
  assert.deepEqual(h.apiCalls().map((c) => `${c.method} ${c.url}`), ["GET https://io.clearstory.build/clearstory/v1/company"]);
});
