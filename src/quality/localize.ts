import { roughTokens } from "../context/tokens.js";
import { isAuxiliary, type RepoIndex } from "../index/repo-index.js";
import type { Check } from "./types.js";

export interface Signals {
  identifiers: string[];
  paths: { path: string; line?: number }[];
  testNames: string[];
}

const CODE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|c|h|cc|cpp|hpp|swift|scala)";

/**
 * Pull localization signals out of free text (a request or test output):
 * file paths with optional line numbers, stack-frame locations, code-like
 * identifiers (backticked, CamelCase, snake_case, calls) and quoted test names.
 */
export function extractSignals(text: string): Signals {
  const paths = new Map<string, number | undefined>();
  const addPath = (p: string, line?: number) => {
    const clean = p.replace(/^\.\//, "").replace(/^file:\/\//, "");
    if (!paths.has(clean) || (line && !paths.get(clean))) paths.set(clean, line);
  };
  for (const m of text.matchAll(new RegExp(`((?:[\\w@.-]+/)*[\\w@.-]+\\.${CODE_EXT})(?::(\\d+))?(?::\\d+)?\\b`, "g"))) addPath(m[1]!, m[2] ? Number(m[2]) : undefined);
  for (const m of text.matchAll(/File "([^"]+)", line (\d+)/g)) addPath(m[1]!, Number(m[2]));

  const ids = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$.]*)`/g)) ids.add(m[1]!.replace(/\(\)$/, ""));
  for (const m of text.matchAll(/\b([a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z]+_[a-z_]+[a-z]|[A-Za-z_$][\w$]*)(?=\()/g)) ids.add(m[1]!);
  for (const m of text.matchAll(/\b([a-z]+[A-Z][\w$]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) ids.add(m[1]!);
  const COMMON = new Set(["console.log", "TypeError", "Error", "JavaScript", "TypeScript", "GitHub", "README", "JSON", "Node"]);

  const testNames = new Set<string>();
  for (const m of text.matchAll(/["“']([^"”'\n]{6,120})["”']/g)) testNames.add(m[1]!.trim());

  return {
    identifiers: [...ids].filter((i) => i.length >= 4 && !COMMON.has(i)).slice(0, 12),
    paths: [...paths.entries()].map(([path, line]) => ({ path, ...(line ? { line } : {}) })).slice(0, 10),
    testNames: [...testNames].slice(0, 8),
  };
}

export interface PacketInput {
  request: string;
  index: RepoIndex;
  baseline?: Check | null;
  baselineNote?: string;
  maxTokens?: number;
}

/**
 * A small, harness-built evidence packet for the start of a turn: where the
 * request probably points in the code, by several independent signals.
 * Graph edges and regex-extracted symbols are hints; the packet says so.
 */
export function buildEvidencePacket(i: PacketInput): { text: string; files: string[] } | null {
  const idx = i.index;
  if (!idx.files().length) return null;
  const budget = i.maxTokens ?? 1500;
  const sig = extractSignals(i.request + (i.baseline ? `\n${i.baseline.failing?.join("\n") ?? ""}` : ""));
  const lines: string[] = [];
  const files = new Map<string, string[]>(); // path → reasons
  const note = (path: string, why: string) => {
    if (!idx.get(path)) return;
    const r = files.get(path) ?? [];
    if (!r.includes(why)) r.push(why);
    files.set(path, r);
  };

  // 1. Paths and stack frames mentioned directly.
  for (const p of sig.paths) {
    const match = idx.files().find((f) => f.path === p.path || f.path.endsWith("/" + p.path));
    if (!match) continue;
    const sym = p.line ? idx.enclosingSymbol(match.path, p.line) : undefined;
    note(match.path, p.line ? `mentioned at line ${p.line}${sym ? ` (inside ${sym.parent ? sym.parent + "." : ""}${sym.name})` : ""}` : "mentioned in the request");
  }
  // 2. Identifiers: definitions and references.
  const defLines: string[] = [];
  for (const id of sig.identifiers) {
    const defs = idx.findDefinitions(id).slice(0, 3);
    for (const d of defs) {
      defLines.push(`- \`${id}\` defined at ${d.file.path}:${d.symbol.line} — ${d.symbol.signature}`);
      note(d.file.path, `defines ${id}`);
    }
    if (defs.length) {
      const refs = idx.filesReferencing(id.split(".").pop()!).filter((p) => !defs.some((d) => d.file.path === p)).slice(0, 4);
      for (const r of refs) note(r, `uses ${id}`);
    }
  }
  // 3. Failing tests from the baseline: where they live.
  const testLines: string[] = [];
  for (const name of [...(i.baseline?.failing ?? []), ...sig.testNames].slice(0, 6)) {
    const hit = idx.search(name, { limit: 3 }).find((h) => isAuxiliary(h.path));
    if (hit) {
      testLines.push(`- "${name}" → ${hit.path}:${hit.startLine}`);
      note(hit.path, "contains a relevant test");
    }
  }
  // 4. Ranked search over the request text.
  for (const h of idx.search(i.request, { limit: 6 })) note(h.path, `matches the request (${h.symbol ?? `lines ${h.startLine}-${h.endLine}`})`);

  const ranked = [...files.entries()].sort((a, b) => b[1].length - a[1].length || Number(isAuxiliary(a[0])) - Number(isAuxiliary(b[0])));
  lines.push("[Sutra evidence packet — built by the harness from the code index; hints, not facts. Verify in source, and expand with find_symbol, code_search or read_file.]");
  if (i.baseline) {
    lines.push(
      `Baseline before any edit: \`${i.baseline.command}\` → exit ${i.baseline.exitCode ?? "?"}${i.baseline.counts ? `, ${i.baseline.counts.failed} of ${i.baseline.counts.total} failing` : ""}${i.baseline.failing?.length ? `: ${i.baseline.failing.slice(0, 5).map((n) => `"${n}"`).join(", ")}` : ""}`,
    );
  } else if (i.baselineNote) lines.push(`Baseline: ${i.baselineNote}`);
  if (ranked.length) {
    lines.push("Likely locations:");
    for (const [p, why] of ranked.slice(0, 8)) {
      const nb = idx.neighbors(p, 3);
      const edges = [nb.uses.length ? `uses ${nb.uses.join(", ")}` : "", nb.usedBy.length ? `used by ${nb.usedBy.join(", ")}` : ""].filter(Boolean).join("; ");
      lines.push(`- ${p} — ${why.slice(0, 3).join("; ")}${edges ? ` [${edges}]` : ""}`);
    }
  }
  if (defLines.length) lines.push("Definitions:", ...defLines.slice(0, 8));
  if (testLines.length) lines.push("Tests:", ...testLines);

  // Trim to budget from the bottom.
  let text = lines.join("\n");
  while (roughTokens(text) > budget && lines.length > 3) {
    lines.splice(lines.length - 1, 1);
    text = lines.join("\n");
  }
  if (!ranked.length && !i.baseline && !defLines.length) return null;
  return { text, files: ranked.map(([p]) => p) };
}
