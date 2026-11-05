import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

export const ALWAYS_IGNORED = [".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", "target"];

export function loadIgnore(root: string): Ignore {
  const ig = ignore();
  ig.add(ALWAYS_IGNORED.map((d) => `${d}/`));
  const gi = join(root, ".gitignore");
  if (existsSync(gi)) {
    try {
      ig.add(readFileSync(gi, "utf8"));
    } catch {
      /* unreadable .gitignore */
    }
  }
  return ig;
}

/**
 * Walk files under `dir` (inside `root`), honouring .gitignore at the root and
 * the default ignore list. Does not follow symlinked directories, which keeps
 * the walk inside the workspace.
 */
export async function* walkFiles(root: string, dir: string, opts: { limit?: number; signal?: AbortSignal } = {}): AsyncIterable<string> {
  const ig = loadIgnore(root);
  const limit = opts.limit ?? 50_000;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    if (opts.signal?.aborted) return;
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(current, e.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (!rel || rel.startsWith("..")) continue;
      if (e.isDirectory()) {
        if (!ig.ignores(rel + "/")) stack.push(abs);
      } else if (e.isFile()) {
        if (ig.ignores(rel)) continue;
        yield rel;
        if (++count >= limit) return;
      }
    }
  }
}
