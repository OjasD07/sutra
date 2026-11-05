import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "../src/paginate.js";

const items = Array.from({ length: 23 }, (_, i) => i + 1);

test("page 1 starts at the first item", () => {
  assert.deepEqual(paginate(items, 1, 10).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("the last page holds the remainder", () => {
  const last = paginate(items, 3, 10);
  assert.deepEqual(last.items, [21, 22, 23]);
  assert.equal(last.hasNext, false);
});

test("totalPages rounds up", () => {
  assert.equal(paginate(items, 1, 10).totalPages, 3);
  assert.equal(paginate([], 1, 10).totalPages, 0);
});

test("hasNext is true before the last page", () => {
  assert.equal(paginate(items, 2, 10).hasNext, true);
});

test("rejects a non-positive page size", () => {
  assert.throws(() => paginate(items, 1, 0), RangeError);
});
