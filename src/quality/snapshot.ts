import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadIgnore } from "../utils/walk.js";

/** Large dependency directories linked (read-only use) rather than copied. */
const LINKED_DIRS = ["node_modules", ".venv", "venv", "vendor", "target", ".gradle", "Pods"];

export interface Snapshot {
  dir: string;
  files: number;
  bytes: number;
  /** Dependency directories symlinked to the original rather than copied. */
  linked: string[];
  cleanup(): void;
}

export interface SnapshotOptions {
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * Copy the workspace into a fresh temporary directory: every file that isn't
 * ignored (including uncommitted and untracked ones), excluding .git, with
 * large dependency directories symlinked so tests can still run. The copy is
 * disposable; nothing in it touches the user's checkout.
 */
export function snapshotWorkspace(root: string, opts: SnapshotOptions = {}): Snapshot {
  const maxBytes = opts.maxBytes ?? 300 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 20_000;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sutra-snapshot-")));
  const ig = loadIgnore(root);
  let files = 0;
  let bytes = 0;
  const linked: string[] = [];
  for (const name of LINKED_DIRS) {
    const src = join(root, name);
    if (existsSync(src) && statSync(src).isDirectory()) {
      symlinkSync(src, join(dir, name), "dir");
      linked.push(name);
    }
  }
  const stack = [root];
  try {
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const abs = join(cur, e.name);
        const rel = relative(root, abs).split("\\").join("/");
        if (rel === ".git" || rel.startsWith(".git/")) continue;
        if (cur === root && LINKED_DIRS.includes(e.name)) continue;
        if (e.isDirectory()) {
          if (!ig.ignores(rel + "/")) stack.push(abs);
          continue;
        }
        if (e.isSymbolicLink() || !e.isFile() || ig.ignores(rel)) continue;
        const size = lstatSync(abs).size;
        files++;
        bytes += size;
        if (files > maxFiles || bytes > maxBytes) throw new Error(`workspace too large to snapshot (> ${maxFiles} files or ${Math.round(maxBytes / 1e6)} MB)`);
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(abs, dest);
      }
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, files, bytes, linked, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Content hashes of the snapshot's files (excluding linked dependency dirs). */
export function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, e.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (rel !== ".git") stack.push(abs);
      } else if (e.isFile()) out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  }
  return out;
}

/** Files added, removed or modified between two hashed trees. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [p, h] of after) if (before.get(p) !== h) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);
  return [...changed].sort();
}

/** A short identifier for the current contents of a set of files. */
export function treeHash(root: string, paths: string[]): string | null {
  if (!paths.length) return null;
  const h = createHash("sha256");
  for (const p of [...paths].sort()) {
    h.update(p);
    const abs = join(root, p);
    h.update(existsSync(abs) ? readFileSync(abs) : "∅");
  }
  return h.digest("hex").slice(0, 12);
}
