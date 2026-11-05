import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildAudit } from "../audit/audit.js";
import { renderJson, renderMarkdown, renderReplay } from "../audit/render.js";
import { paths } from "../config/paths.js";
import type { SessionStore } from "../memory/store.js";
import type { Theme } from "../tui/theme.js";
import type { CliArgs } from "./args.js";

/** Pick the session: an explicit id/prefix, else the latest one in this directory. */
export function resolveSessionId(store: SessionStore, workspaceRoot: string, target?: string): string {
  if (target) {
    const s = store.getSession(target);
    if (!s) throw new Error(`No session matching "${target}". List them with /sessions or \`sutra replay\` in the project directory.`);
    return s.id;
  }
  const latest = store.latestSession(workspaceRoot);
  if (!latest) throw new Error("No sessions in this directory yet. Pass a session id.");
  return latest.id;
}

/** Write an audit report; returns the path. Default location is outside any repository. */
export function exportAudit(store: SessionStore, sessionId: string, format: "md" | "json", out?: string): string {
  const audit = buildAudit(store, sessionId);
  const file = out ? resolve(out) : join(paths.exports(), `${sessionId.slice(0, 8)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, format === "md" ? renderMarkdown(audit) : renderJson(audit), { mode: 0o600 });
  return file;
}

export function runAuditCommand(command: "replay" | "export", store: SessionStore, workspaceRoot: string, args: CliArgs, ui: { theme: Theme; color: boolean }): number {
  let id: string;
  try {
    id = resolveSessionId(store, workspaceRoot, args.target ?? args.session);
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n`);
    return 1;
  }
  if (command === "replay") {
    if (args.json) process.stdout.write(renderJson(buildAudit(store, id)));
    else process.stdout.write(renderReplay(buildAudit(store, id), { ...ui, width: process.stdout.columns || 100 }));
    return 0;
  }
  const file = exportAudit(store, id, args.format ?? "md", args.out);
  process.stdout.write(`Wrote ${args.format ?? "md"} audit of session ${id.slice(0, 8)} to ${file}\n`);
  return 0;
}
