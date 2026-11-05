import { describe, expect, it } from "vitest";
import { decideFocusMap } from "../../src/context/focus-map.js";
import { RepoIndex } from "../../src/index/repo-index.js";
import { tempDir, writeFiles } from "../helpers/harness.js";

function repo(): RepoIndex {
  const root = tempDir();
  writeFiles(root, {
    "src/session.ts": "export function isExpired(s: { expiresAt: number }, now: number) {\n  return s.expiresAt < now;\n}\nexport function refreshSession() {}\n",
    "src/api.ts": "import { isExpired } from './session';\nexport function handle(s: any) {\n  if (isExpired(s, 1)) return 401;\n}\n",
    "src/routes.ts": "import { handle } from './api';\nexport function route() { return handle({}); }\n",
    "src/util/format.ts": "export function formatDate(d: Date) { return d.toISOString(); }\nexport function handleDate() {}\n",
    "test/session.test.ts": "import { isExpired } from '../src/session';\ntest('expired sessions are rejected', () => {});\n",
  });
  const idx = new RepoIndex(root, { maxFiles: 100 });
  idx.refresh();
  return idx;
}

describe("conditional repository map", () => {
  const idx = repo();
  it("skips the map when the request names the file", () => {
    const d = decideFocusMap(idx, "Fix the off-by-one in src/session.ts please", 800);
    expect(d.text).toBeNull();
    expect(d.reason).toBe("request names src/session.ts");
  });
  it("skips the map when an identifier has a single definition", () => {
    const d = decideFocusMap(idx, "make `isExpired` inclusive of the boundary", 800);
    expect(d.text).toBeNull();
    expect(d.reason).toMatch(/identifier resolves to src\/session\.ts/);
  });
  it("skips short follow-ups", () => {
    expect(decideFocusMap(idx, "yes do it", 800).text).toBeNull();
  });
  it("adds a focused map for an ambiguous request", () => {
    const d = decideFocusMap(idx, "users get logged out too early, the session handling seems wrong", 800);
    expect(d.text).toContain("[Sutra repository map");
    expect(d.text).toContain("src/session.ts");
    expect(d.reason).toBe("the request is ambiguous");
  });
  it("adds a map when the request crosses files, even with a named file", () => {
    const d = decideFocusMap(idx, "rename isExpired everywhere and update src/api.ts", 800);
    expect(d.text).not.toBeNull();
    expect(d.reason).toBe("the request spans files");
    expect(d.focus).toContain("src/api.ts");
  });
});
