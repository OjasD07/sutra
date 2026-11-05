import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseCsvLine } from "../src/csv.js";

test("splits plain fields", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("keeps empty fields", () => {
  assert.deepEqual(parseCsvLine("a,,c,"), ["a", "", "c", ""]);
});

test("commas inside quotes are literal", () => {
  assert.deepEqual(parseCsvLine('1,"Doe, Jane",admin'), ["1", "Doe, Jane", "admin"]);
});

test("doubled quotes are escaped quotes", () => {
  assert.deepEqual(parseCsvLine('"She said ""hi""",x'), ['She said "hi"', "x"]);
});

test("parses a document with CRLF line endings", () => {
  assert.deepEqual(parseCsv('id,name\r\n1,"Smith, A"\r\n'), [["id", "name"], ["1", "Smith, A"]]);
});
