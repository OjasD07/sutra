export interface TestCounts {
  passed: number;
  failed: number;
  total: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Best-effort extraction of pass/fail counts from common test runners'
 * summaries (node:test, vitest, jest, pytest, cargo, mocha). Returns null when
 * nothing recognisable is found; callers then show only the exit code.
 */
export function parseTestCounts(raw: string): TestCounts | null {
  const out = raw.replace(ANSI, "");
  const num = (re: RegExp): number | null => {
    const all = [...out.matchAll(new RegExp(re, re.flags.includes("g") ? re.flags : re.flags + "g"))];
    const m = all.at(-1);
    return m ? Number(m[1]) : null;
  };
  const make = (passed: number, failed: number): TestCounts => ({ passed, failed, total: passed + failed });

  // node:test — "# pass 4" (TAP) or "ℹ pass 4" (spec reporter)
  const nodePass = num(/^(?:#|ℹ) pass (\d+)/m);
  const nodeFail = num(/^(?:#|ℹ) fail (\d+)/m);
  if (nodePass !== null && nodeFail !== null) return make(nodePass, nodeFail);

  // vitest — "Tests  2 failed | 4 passed (6)"
  const vitest = [...out.matchAll(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/g)].at(-1);
  if (vitest) return make(Number(vitest[2]), Number(vitest[1] ?? 0));
  const vitestFailOnly = [...out.matchAll(/Tests\s+(\d+) failed \((\d+)\)/g)].at(-1);
  if (vitestFailOnly) return make(Number(vitestFailOnly[2]) - Number(vitestFailOnly[1]), Number(vitestFailOnly[1]));

  // jest — "Tests:       1 failed, 3 passed, 4 total"
  const jest = [...out.matchAll(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?(\d+) total/g)].at(-1);
  if (jest) return make(Number(jest[2] ?? 0), Number(jest[1] ?? 0));

  // cargo — "test result: FAILED. 3 passed; 1 failed;"
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.reduce((acc, m) => make(acc.passed + Number(m[1]), acc.failed + Number(m[2])), make(0, 0));

  // pytest — "==== 1 failed, 3 passed in 0.12s ===="
  const pytest = [...out.matchAll(/=+ (?:(\d+) failed,? ?)?(?:(\d+) passed)?[^=\n]* in [\d.]+s/g)].at(-1);
  if (pytest && (pytest[1] || pytest[2])) return make(Number(pytest[2] ?? 0), Number(pytest[1] ?? 0));

  // mocha — "4 passing" / "1 failing"
  const mochaPass = num(/^\s*(\d+) passing/m);
  if (mochaPass !== null) return make(mochaPass, num(/^\s*(\d+) failing/m) ?? 0);
  return null;
}
