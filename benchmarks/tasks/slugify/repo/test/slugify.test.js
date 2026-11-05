import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.js";

test("lower-cases and joins words with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation and whitespace runs", () => {
  assert.equal(slugify("  Sutra:   the -- thread!  "), "sutra-the-thread");
});

test("removes accents", () => {
  assert.equal(slugify("Crème Brûlée à la carte"), "creme-brulee-a-la-carte");
});

test("keeps digits", () => {
  assert.equal(slugify("Top 10 tips for 2026"), "top-10-tips-for-2026");
});

test("returns an empty string when nothing is left", () => {
  assert.equal(slugify("!!! ???"), "");
});

test("maxLength cuts at a word boundary", () => {
  assert.equal(slugify("The quick brown fox jumps", { maxLength: 15 }), "the-quick-brown");
  assert.equal(slugify("The quick brown fox jumps", { maxLength: 14 }), "the-quick");
});

test("maxLength never leaves a trailing dash", () => {
  assert.ok(!slugify("alpha beta gamma", { maxLength: 6 }).endsWith("-"));
});
