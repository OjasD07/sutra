import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createTwoFilesPatch, structuredPatch } from "diff";
import { sha256 } from "../../utils/text.js";
import { ToolFailure } from "../types.js";

/**
 * Atomic write: write a temp file in the same directory, fsync, then rename
 * over the target. Readers see either the old or the new content, never a
 * partial file. Existing file permissions are preserved. The result is read
 * back and verified.
 */
export function atomicWrite(absPath: string, content: string): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(absPath) ? statSync(absPath).mode & 0o7777 : 0o644;
  const tmp = join(dir, `.${basename(absPath)}.sutra-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  const written = readFileSync(absPath);
  if (sha256(written) !== sha256(Buffer.from(content, "utf8"))) {
    throw new ToolFailure("execution_failed", `Verification failed after writing ${absPath}`);
  }
}

export function unifiedDiff(display: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${display}`, `b/${display}`, before, after, "", "", { context: 3 });
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  const p = structuredPatch("a", "b", before, after, "", "", { context: 0 });
  let added = 0;
  let removed = 0;
  for (const h of p.hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  return { added, removed };
}

export function readText(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}
