import { existsSync, statSync, unlinkSync } from "node:fs";
import { applyPatch, parsePatch } from "diff";
import { z } from "zod";
import type { ResolvedPath } from "../../permissions/paths.js";
import { countLines } from "../../utils/text.js";
import { ToolFailure, fail, ok, type Tool, type ToolContext, type ToolPreview } from "../types.js";
import { atomicWrite, diffStats, readText, unifiedDiff } from "./atomic.js";

interface FileChange {
  path: ResolvedPath;
  before: string | null;
  after: string | null; // null = delete
}

function previewOf(changes: FileChange[]): ToolPreview {
  let added = 0;
  let removed = 0;
  const diffs: string[] = [];
  for (const c of changes) {
    const s = diffStats(c.before ?? "", c.after ?? "");
    added += s.added;
    removed += s.removed;
    diffs.push(unifiedDiff(c.path.display, c.before ?? "", c.after ?? ""));
  }
  const files = changes.map((c) => `${c.path.display}${c.before === null ? " (new)" : c.after === null ? " (delete)" : ""}`);
  return { summary: `+${added} / -${removed} lines in ${files.join(", ")}`, diff: diffs.join("\n"), details: files };
}

function commit(changes: FileChange[], ctx: ToolContext): { added: number; removed: number; diff: string } {
  // Check every file first so a multi-file change is not half-applied because
  // of a stale file discovered midway.
  for (const c of changes) if (c.before !== null) ctx.fileState.assertWritable(c.path.absolute, c.path.display);
  let added = 0;
  let removed = 0;
  const diffs: string[] = [];
  for (const c of changes) {
    if (c.after === null) unlinkSync(c.path.absolute);
    else atomicWrite(c.path.absolute, c.after);
    ctx.fileState.record(c.path.absolute);
    const s = diffStats(c.before ?? "", c.after ?? "");
    added += s.added;
    removed += s.removed;
    diffs.push(unifiedDiff(c.path.display, c.before ?? "", c.after ?? ""));
  }
  return { added, removed, diff: diffs.join("\n") };
}

function guard<T>(fn: () => T): T | ReturnType<typeof fail> {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ToolFailure) return fail(err.code, err.message, { retryable: err.retryable });
    throw err;
  }
}

function assertTextTarget(p: ResolvedPath): void {
  if (existsSync(p.absolute) && statSync(p.absolute).isDirectory()) throw new ToolFailure("invalid_arguments", `${p.display} is a directory`);
}

// ---------------------------------------------------------------- write_file

type WriteArgs = { path: string; content: string };

function planWrite(a: WriteArgs, ctx: ToolContext): FileChange[] {
  const p = ctx.workspace.resolve(a.path);
  assertTextTarget(p);
  return [{ path: p, before: readText(p.absolute), after: a.content }];
}

export const writeFileTool: Tool<WriteArgs> = {
  name: "write_file",
  description:
    "Create a new file or fully replace an existing one. Existing files must have been read in this session and be unchanged on disk. Prefer edit_file for small changes.",
  version: "1.0.0",
  category: "write",
  readOnly: false,
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  describe: (a, ctx) => ({ tool: "write_file", category: "write", paths: [ctx.workspace.resolve(a.path)], summary: `Write ${a.path}` }),
  preview: async (a, ctx) => previewOf(planWrite(a, ctx)),
  async execute(a, ctx) {
    return guard(() => {
      const changes = planWrite(a, ctx);
      const r = commit(changes, ctx);
      const created = changes[0]!.before === null;
      return ok(`${created ? "Created" : "Updated"} ${changes[0]!.path.display} (${countLines(a.content)} lines, +${r.added} / -${r.removed}).`, {
        files: [changes[0]!.path.display],
        added: r.added,
        removed: r.removed,
        diff: r.diff,
      });
    });
  },
};

// ----------------------------------------------------------------- edit_file

type EditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean };

function planEdit(a: EditArgs, ctx: ToolContext): FileChange[] {
  const p = ctx.workspace.resolve(a.path);
  assertTextTarget(p);
  const before = readText(p.absolute);
  if (before === null) throw new ToolFailure("not_found", `No such file: ${p.display}. Use write_file to create it.`);
  if (a.old_string === a.new_string) throw new ToolFailure("invalid_arguments", "old_string and new_string are identical");
  if (a.old_string.length === 0) throw new ToolFailure("invalid_arguments", "old_string must not be empty");
  const count = before.split(a.old_string).length - 1;
  if (count === 0) throw new ToolFailure("conflict", `old_string was not found in ${p.display}. Re-read the file and copy the exact text, including whitespace.`, true);
  if (count > 1 && !a.replace_all)
    throw new ToolFailure("conflict", `old_string occurs ${count} times in ${p.display}. Include more surrounding context to make it unique, or set replace_all.`, true);
  const after = a.replace_all ? before.split(a.old_string).join(a.new_string) : before.replace(a.old_string, () => a.new_string);
  return [{ path: p, before, after }];
}

export const editFileTool: Tool<EditArgs> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file exactly (without read_file's line-number prefixes) and be unique unless replace_all is set. The file must have been read first.",
  version: "1.0.0",
  category: "write",
  readOnly: false,
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional(),
  }),
  describe: (a, ctx) => ({ tool: "edit_file", category: "write", paths: [ctx.workspace.resolve(a.path)], summary: `Edit ${a.path}` }),
  preview: async (a, ctx) => previewOf(planEdit(a, ctx)),
  async execute(a, ctx) {
    return guard(() => {
      const changes = planEdit(a, ctx);
      const r = commit(changes, ctx);
      return ok(`Edited ${changes[0]!.path.display} (+${r.added} / -${r.removed}).`, {
        files: [changes[0]!.path.display],
        added: r.added,
        removed: r.removed,
        diff: r.diff,
      });
    });
  },
};

// --------------------------------------------------------------- apply_patch

type PatchArgs = { patch: string };

function stripPrefix(name: string | undefined): string | null {
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "").split("\t")[0]!.trim();
}

function planPatch(a: PatchArgs, ctx: ToolContext): FileChange[] {
  let parsed;
  try {
    parsed = parsePatch(a.patch);
  } catch (err) {
    throw new ToolFailure("invalid_arguments", `Could not parse patch: ${(err as Error).message}`);
  }
  const files = parsed.filter((p) => p.hunks.length > 0);
  if (files.length === 0) throw new ToolFailure("invalid_arguments", "Patch contains no hunks");
  const changes: FileChange[] = [];
  for (const fp of files) {
    const oldName = stripPrefix(fp.oldFileName);
    const newName = stripPrefix(fp.newFileName);
    const target = newName ?? oldName;
    if (!target) throw new ToolFailure("invalid_arguments", "Patch hunk has no file name");
    const path = ctx.workspace.resolve(target);
    assertTextTarget(path);
    const before = oldName ? readText(ctx.workspace.resolve(oldName).absolute) : null;
    if (oldName && before === null) throw new ToolFailure("not_found", `Patch targets missing file ${oldName}`);
    if (!oldName && readText(path.absolute) !== null) throw new ToolFailure("conflict", `Patch creates ${target}, but it already exists`);
    if (newName === null) {
      changes.push({ path, before, after: null });
      continue;
    }
    const result = applyPatch(before ?? "", fp);
    if (result === false)
      throw new ToolFailure("conflict", `Patch does not apply cleanly to ${target}. Re-read the file and regenerate the hunk with exact context lines.`, true);
    changes.push({ path, before, after: result });
  }
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.path.absolute)) throw new ToolFailure("invalid_arguments", `Patch touches ${c.path.display} more than once`);
    seen.add(c.path.absolute);
  }
  return changes;
}

export const applyPatchTool: Tool<PatchArgs> = {
  name: "apply_patch",
  description:
    "Apply a unified diff (git-style, '--- a/path' / '+++ b/path' headers, @@ hunks) that may touch several files. Use '/dev/null' to create or delete a file. All target files must have been read first; nothing is written unless every hunk applies.",
  version: "1.0.0",
  category: "write",
  readOnly: false,
  schema: z.object({ patch: z.string().min(1) }),
  describe(a, ctx) {
    let paths: ResolvedPath[] = [];
    let deletes = false;
    try {
      for (const fp of parsePatch(a.patch)) {
        const name = stripPrefix(fp.newFileName) ?? stripPrefix(fp.oldFileName);
        if (stripPrefix(fp.newFileName) === null) deletes = true;
        if (name) paths.push(ctx.workspace.resolve(name));
      }
    } catch {
      paths = [];
    }
    return { tool: "apply_patch", category: "write", paths, summary: `Apply patch to ${paths.map((p) => p.display).join(", ") || "(unparseable)"}`, destructive: deletes };
  },
  preview: async (a, ctx) => previewOf(planPatch(a, ctx)),
  async execute(a, ctx) {
    return guard(() => {
      const changes = planPatch(a, ctx);
      const r = commit(changes, ctx);
      const files = changes.map((c) => c.path.display);
      return ok(`Patched ${files.length} file(s): ${files.join(", ")} (+${r.added} / -${r.removed}).`, { files, added: r.added, removed: r.removed, diff: r.diff });
    });
  },
};
