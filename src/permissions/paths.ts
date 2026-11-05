import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathViolation";
  }
}

/**
 * Canonicalise a path, following symlinks. For paths that don't exist yet,
 * the nearest existing ancestor is canonicalised and the rest re-appended,
 * so a not-yet-created file under a symlinked directory is still resolved to
 * where it would actually land.
 */
export function canonicalize(p: string): string {
  const abs = resolve(p);
  let current = abs;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(current);
  } catch {
    real = current;
  }
  return tail.length ? resolve(real, ...tail) : real;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

export interface ResolvedPath {
  /** Canonical absolute path (symlinks resolved). */
  absolute: string;
  /** Path relative to the workspace root, for display. */
  display: string;
  insideWorkspace: boolean;
}

export class Workspace {
  readonly root: string;
  constructor(root: string) {
    this.root = canonicalize(root);
  }

  /** Resolve user/model supplied paths relative to the workspace root. */
  resolve(input: string): ResolvedPath {
    if (typeof input !== "string" || input.length === 0) throw new PathViolation("Path must be a non-empty string");
    if (input.includes("\0")) throw new PathViolation("Path contains a NUL byte");
    const expanded = input.startsWith("~/") ? resolve(process.env.HOME ?? "/", input.slice(2)) : input;
    const absolute = canonicalize(isAbsolute(expanded) ? expanded : resolve(this.root, expanded));
    const insideWorkspace = isInside(this.root, absolute);
    const display = insideWorkspace ? relative(this.root, absolute) || "." : absolute;
    return { absolute, display, insideWorkspace };
  }

  /** Resolve and require the result to be inside the workspace. */
  resolveInside(input: string): ResolvedPath {
    const r = this.resolve(input);
    if (!r.insideWorkspace) throw new PathViolation(`Path escapes the workspace: ${input} -> ${r.absolute}`);
    return r;
  }
}
