import { existsSync, readFileSync, statSync } from "node:fs";
import { sha256 } from "../utils/text.js";
import { ToolFailure } from "./types.js";

interface Snapshot {
  hash: string;
  mtimeMs: number;
  size: number;
}

/**
 * Tracks the last content the agent observed for each file so that edits can
 * never silently overwrite changes made by someone else (an editor, a
 * formatter, the user) since the agent last looked.
 */
export class FileStateTracker {
  private snapshots = new Map<string, Snapshot>();

  record(absPath: string, content?: Buffer | string): void {
    if (!existsSync(absPath)) {
      this.snapshots.delete(absPath);
      return;
    }
    const st = statSync(absPath);
    const data = content ?? readFileSync(absPath);
    this.snapshots.set(absPath, { hash: sha256(data), mtimeMs: st.mtimeMs, size: st.size });
  }

  has(absPath: string): boolean {
    return this.snapshots.has(absPath);
  }

  /**
   * Throws unless it is safe to overwrite `absPath`: either the file doesn't
   * exist, or it is unchanged since the agent last read or wrote it.
   */
  assertWritable(absPath: string, display: string): void {
    if (!existsSync(absPath)) return;
    const snap = this.snapshots.get(absPath);
    if (!snap) {
      throw new ToolFailure("stale_file", `${display} exists but has not been read in this session. Read it before modifying it.`, true);
    }
    const st = statSync(absPath);
    if (st.size === snap.size && st.mtimeMs === snap.mtimeMs) return;
    const hash = sha256(readFileSync(absPath));
    if (hash !== snap.hash) {
      throw new ToolFailure("stale_file", `${display} changed on disk since it was last read. Read it again before modifying it.`, true);
    }
  }

  toJSON(): Record<string, Snapshot> {
    return Object.fromEntries(this.snapshots);
  }

  static fromJSON(data: Record<string, Snapshot> | undefined): FileStateTracker {
    const t = new FileStateTracker();
    for (const [k, v] of Object.entries(data ?? {})) t.snapshots.set(k, v);
    return t;
  }
}
