import { Chalk, type ChalkInstance } from "chalk";
import hljs from "highlight.js/lib/common";
import type { Theme } from "./theme.js";

/** A chalk instance at the terminal's detected colour level (0 when disabled). */
function makeChalk(color: boolean): ChalkInstance {
  return color ? new Chalk() : new Chalk({ level: 0 });
}

/** Map highlight.js scopes to theme colours. */
function styleFor(c: ChalkInstance, theme: Theme, cls: string): (s: string) => string {
  if (/keyword|built_in|selector-tag|doctag/.test(cls)) return c.hex(theme.accent);
  if (/string|regexp|addition|attribute/.test(cls)) return c.hex(theme.success);
  if (/number|literal|symbol|bullet/.test(cls)) return c.hex(theme.info);
  if (/comment|quote|meta/.test(cls)) return c.hex(theme.muted).italic;
  if (/title|section|name/.test(cls)) return c.bold;
  if (/deletion/.test(cls)) return c.hex(theme.error);
  return (s) => s;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Convert highlight.js HTML output to ANSI, handling nested spans. */
function htmlToAnsi(html: string, c: ChalkInstance, theme: Theme): string {
  const stack: ((s: string) => string)[] = [];
  let out = "";
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) stack.push(styleFor(c, theme, m[1]));
    else if (m[0] === "</span>") stack.pop();
    else if (m[2]) {
      const text = decode(m[2]);
      const style = stack[stack.length - 1];
      out += style ? text.split("\n").map(style).join("\n") : text;
    }
  }
  return out;
}

export function highlightCode(code: string, lang: string | undefined, theme: Theme, color: boolean): string {
  if (!color) return code;
  const c = makeChalk(true);
  try {
    const res = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }) : hljs.highlightAuto(code);
    return htmlToAnsi(res.value, c, theme);
  } catch {
    return code;
  }
}

export function languageForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby", sh: "bash", zsh: "bash", json: "json",
    md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", css: "css", html: "xml", c: "c", h: "c", cpp: "cpp", cs: "csharp", kt: "kotlin", swift: "swift", sql: "sql",
  };
  return ext ? map[ext] : undefined;
}

/**
 * Colour a unified diff. Added/removed lines additionally get the file's
 * syntax highlighting where the language is known.
 */
export function renderDiff(diff: string, theme: Theme, color: boolean, maxLines = 60): string {
  const lines = diff.split("\n").filter((l) => !/^(={3,}|Index: )/.test(l));
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  if (!color) return shown.join("\n") + (more > 0 ? `\n… ${more} more lines` : "");
  const c = makeChalk(true);
  let lang: string | undefined;
  const out = shown.map((l) => {
    if (l.startsWith("+++ ") || l.startsWith("--- ")) {
      if (l.startsWith("+++ ")) lang = languageForPath(l.slice(4).trim());
      return c.bold(l);
    }
    if (l.startsWith("@@")) return c.hex(theme.info)(l);
    if (l.startsWith("+")) return c.hex(theme.success)("+") + c.hex(theme.success)(l.slice(1));
    if (l.startsWith("-")) return c.hex(theme.error)("-") + c.hex(theme.error)(l.slice(1));
    if (l.startsWith(" ") && lang) return " " + highlightCode(l.slice(1), lang, theme, true);
    return c.hex(theme.muted)(l);
  });
  if (more > 0) out.push(c.hex(theme.muted)(`… ${more} more lines`));
  return out.join("\n");
}

/** Minimal Markdown → ANSI for assistant messages (headings, emphasis, code). */
export function renderMarkdown(md: string, theme: Theme, color: boolean): string {
  const c = makeChalk(color);
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const code = body.join("\n");
      const lang = fence[1] || undefined;
      const rendered = lang === "diff" ? renderDiff(code, theme, color, 200) : highlightCode(code, lang, theme, color);
      out.push(...rendered.split("\n").map((l) => "  " + l));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(c.bold(h[2]!));
      continue;
    }
    out.push(
      line
        .replace(/`([^`]+)`/g, (_m, code: string) => c.hex(theme.accent)(code))
        .replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => c.bold(b))
        .replace(/^(\s*)[-*] /, "$1• "),
    );
  }
  return out.join("\n");
}

export interface DiffRow {
  kind: "file" | "hunk" | "add" | "remove" | "context";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** Parse a unified diff into display rows with old/new line numbers. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split("\n")) {
    if (/^(={3,}|Index: |\\ No newline)/.test(line)) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) {
      rows.push({ kind: "file", text: line.slice(4).replace(/^b\//, "").trim() });
      continue;
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "remove", oldNo: oldNo++, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  // A trailing context row with no text is the diff's final newline, not content.
  while (rows.length && rows[rows.length - 1]!.kind === "context" && rows[rows.length - 1]!.text === "") rows.pop();
  return rows;
}
