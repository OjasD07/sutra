import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureFresh, isExpired, secondsRemaining } from "../src/session.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // ms
const inSeconds = (s) => Math.floor(NOW / 1000) + s;

test("a session that expires in an hour is not expired", () => {
  assert.equal(isExpired({ expiresAt: inSeconds(3600) }, NOW), false);
});

test("a session that expired a minute ago is expired", () => {
  assert.equal(isExpired({ expiresAt: inSeconds(-60) }, NOW), true);
});

test("secondsRemaining counts down", () => {
  assert.equal(secondsRemaining({ expiresAt: inSeconds(90) }, NOW), 90);
});

test("ensureFresh only refreshes expired sessions", async () => {
  let calls = 0;
  const refresh = async () => {
    calls++;
    return { expiresAt: inSeconds(3600), refreshToken: "r2" };
  };
  const live = { expiresAt: inSeconds(600), refreshToken: "r1" };
  assert.equal(await ensureFresh(live, refresh, NOW), live);
  assert.equal(calls, 0);
});
