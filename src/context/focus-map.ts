import type { RepoIndex } from "../index/repo-index.js";
import { extractSignals } from "../quality/localize.js";

export interface MapDecision {
  /** The map text to append to the request, or null to send none. */
  text: string | null;
  /** Why: shown in the thread and recorded in bench results. */
  reason: string;
  focus: string[];
}

const CROSS_FILE = /\b(across|everywhere|all (?:the )?(?:callers|usages|places|files)|throughout|codebase|architecture|refactor|rename|migrate|where (?:is|are|does)|how does|which files?|overview|structure)\b/i;

/**
 * Decide whether this request needs a repository map, and centre it.
 *
 * A map helps when the request is ambiguous or crosses files: the model has to
 * find its way first. It is wasted when the request already points at the
 * code: a named file, a test that resolves to one file, or an identifier with
 * a single definition. Measured on Sutra's own repo, an always-on map added
 * about 2,000 tokens per request with no accuracy gain on targeted tasks.
 */
export function decideFocusMap(index: RepoIndex, request: string, maxTokens: number, opts: { followUp?: boolean; alreadyMapped?: Set<string> } = {}): MapDecision {
  const files = index.files();
  if (!files.length) return { text: null, reason: "index empty", focus: [] };
  const words = request.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 3) return { text: null, reason: "short follow-up", focus: [] };

  const sig = extractSignals(request);
  const named = new Set<string>();
  for (const p of sig.paths) {
    const f = files.find((x) => x.path === p.path || x.path.endsWith("/" + p.path));
    if (f) named.add(f.path);
  }
  const defFiles = new Set<string>();
  let unique = 0;
  for (const id of sig.identifiers) {
    const defs = index.findDefinitions(id);
    if (defs.length === 1) unique++;
    for (const d of defs.slice(0, 3)) defFiles.add(d.file.path);
  }
  const testFiles = new Set<string>();
  for (const name of sig.testNames.slice(0, 4)) {
    const hit = index.search(name, { limit: 2 })[0];
    if (hit) testFiles.add(hit.path);
  }
  const crosses = CROSS_FILE.test(request) || named.size > 1;

  if (!crosses) {
    if (named.size === 1) return { text: null, reason: `request names ${[...named][0]}`, focus: [] };
    if (testFiles.size === 1 && !sig.identifiers.length) return { text: null, reason: `test resolves to ${[...testFiles][0]}`, focus: [] };
    if (unique > 0 && defFiles.size === 1) return { text: null, reason: `identifier resolves to ${[...defFiles][0]}`, focus: [] };
  }

  const focus = [...new Set([...named, ...defFiles, ...testFiles, ...index.search(request, { limit: 5 }).map((h) => h.path)])].slice(0, 12);
  // In an ongoing session the earlier map (and everything read since) is still in context.
  if (opts.followUp && !focus.length) return { text: null, reason: "follow-up without a code location", focus: [] };
  if (opts.alreadyMapped && focus.length && focus.every((f) => opts.alreadyMapped!.has(f))) return { text: null, reason: "these files were already mapped this session", focus };
  const map = index.map({ maxTokens, ...(focus.length ? { focus } : {}) });
  const reason = crosses ? "the request spans files" : focus.length ? "the request is ambiguous" : "the request names no code location";
  return {
    text: `[Sutra repository map — ${focus.length ? `centred on ${focus.slice(0, 4).join(", ")}${focus.length > 4 ? ", …" : ""}` : "most-referenced files"}; included because ${reason}. Expand with repo_map, inspect_symbol or code_search.]\n${map}`,
    reason,
    focus,
  };
}
