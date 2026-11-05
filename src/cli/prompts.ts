import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline";
import { Chalk } from "chalk";
import stringWidth from "string-width";
import type { Theme } from "../tui/theme.js";

/** Returned by a prompt when the user presses Esc: go back a step. */
export const BACK = Symbol("back");
export type Back = typeof BACK;

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  /** Right-aligned status, e.g. "● running" or "key in $OPENROUTER_API_KEY". */
  badge?: string;
  badgeTone?: "ok" | "muted" | "warn";
  group?: string;
  /** Extra words matched by the filter (ids, aliases). */
  keywords?: string;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

/** Cut plain text to a display width, with an ellipsis. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

/**
 * Small interactive prompts for `sutra init`: arrow-key pickers with
 * type-to-filter, masked secrets, validated text and spinners. With piped
 * stdin (scripts, tests) every prompt reads one line instead.
 */
export class Prompter {
  readonly c: InstanceType<typeof Chalk>;
  readonly interactive: boolean;
  private lines: AsyncIterator<string> | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private rendered = 0;

  constructor(
    readonly theme: Theme,
    color: boolean,
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly input: NodeJS.ReadStream = process.stdin,
  ) {
    this.c = color ? new Chalk() : new Chalk({ level: 0 });
    this.interactive = !!input.isTTY && !!out.isTTY;
    if (!this.interactive) {
      // readline's question() drops lines that arrive early on a pipe, so read through one iterator.
      this.rl = createInterface({ input, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
  }

  close(): void {
    this.rl?.close();
    if (this.interactive && this.input.isRaw) this.input.setRawMode(false);
    this.input.pause();
  }

  // ------------------------------------------------------------ styling

  accent = (s: string) => this.c.hex(this.theme.accent)(s);
  muted = (s: string) => this.c.hex(this.theme.muted)(s);
  okc = (s: string) => this.c.hex(this.theme.success)(s);
  errc = (s: string) => this.c.hex(this.theme.error)(s);
  bold = (s: string) => this.c.bold(s);

  write(s = ""): void {
    this.out.write(s + "\n");
  }
  ok(s: string): void {
    this.write(`  ${this.okc("✓")} ${s}`);
  }
  fail(s: string): void {
    this.write(`  ${this.errc("✗")} ${s}`);
  }
  warn(s: string): void {
    this.write(`  ${this.accent("!")} ${s}`);
  }
  info(s: string): void {
    this.write(`    ${this.muted(s)}`);
  }

  private get width(): number {
    return Math.max(40, Math.min(this.out.columns || 80, 110));
  }

  /** Replace what the prompt drew last time. */
  private draw(lines: string[]): void {
    // Cursor up, then column 1 (CSI G, not a bare CR), then clear to the end of the screen.
    if (this.rendered) this.out.write(`\u001b[${this.rendered}A\u001b[1G\u001b[0J`);
    else this.out.write("\u001b[1G\u001b[0J");
    this.out.write(lines.join("\n") + "\n");
    this.rendered = lines.length;
  }

  private done(summary: string): void {
    this.draw([summary]);
    this.rendered = 0;
  }

  private async line(prompt: string, secret = false): Promise<string> {
    this.out.write(prompt);
    const r = await this.lines!.next();
    if (r.done) throw new Error("Input ended before setup finished.");
    const v = r.value.trim();
    this.out.write((secret ? (v ? "•".repeat(Math.min(8, v.length)) : "") : v) + "\n");
    return v;
  }

  /** Read keys until `onKey` resolves the prompt. */
  private keys<T>(onKey: (str: string | undefined, key: Key, finish: (v: T) => void) => void, render: () => void): Promise<T> {
    const input = this.input;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    this.out.write("\u001b[?25l");
    render();
    return new Promise<T>((resolve) => {
      const finish = (v: T) => {
        input.off("keypress", handler);
        input.setRawMode(false);
        input.pause();
        this.out.write("\u001b[?25h");
        resolve(v);
      };
      const handler = (str: string | undefined, key: Key = {}) => {
        if (key.ctrl && key.name === "c") {
          this.out.write("\u001b[?25h\n");
          input.setRawMode(false);
          process.exit(130);
        }
        onKey(str, key, finish);
      };
      input.on("keypress", handler);
    });
  }

  // ------------------------------------------------------------ select

  async select<T>(o: { message: string; choices: Choice<T>[]; initial?: T; filter?: boolean; pageSize?: number; back?: boolean; footer?: string }): Promise<T | Back> {
    const label = (ch: Choice<T>) => ch.label;
    if (!this.interactive) {
      const def = o.choices.find((ch) => ch.value === o.initial) ?? o.choices[0];
      this.write(`  ${o.message}`);
      const a = await this.line(`  ${this.muted(`[${def ? label(def) : ""}]`)} `);
      if (!a) return def!.value;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= o.choices.length) return o.choices[n - 1]!.value;
      const hit = o.choices.find((ch) => String(ch.value).toLowerCase() === a.toLowerCase() || ch.label.toLowerCase() === a.toLowerCase());
      if (hit) return hit.value;
      throw new Error(`"${a}" is not one of: ${o.choices.map((ch) => String(ch.value)).join(", ")}`);
    }

    const pageSize = o.pageSize ?? Math.max(6, Math.min(16, (this.out.rows ?? 24) - 8));
    let query = "";
    let cursor = Math.max(0, o.choices.findIndex((ch) => ch.value === o.initial));
    let top = 0;
    const visible = () => {
      if (!query) return o.choices;
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return o.choices.filter((ch) => {
        const hay = `${ch.label} ${ch.hint ?? ""} ${ch.keywords ?? ""} ${String(ch.value)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    };
    const labelW = Math.min(30, Math.max(...o.choices.map((ch) => stringWidth(ch.label))) + 2);

    const render = () => {
      const list = visible();
      cursor = Math.min(cursor, Math.max(0, list.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + pageSize) top = cursor - pageSize + 1;
      const w = this.width;
      const lines = [`  ${this.accent("?")} ${this.bold(o.message)}${o.filter !== false ? `  ${query ? this.c.underline(query) : this.muted("type to filter")}` : ""}`];
      let lastGroup: string | undefined;
      const page = list.slice(top, top + pageSize);
      if (!list.length) lines.push(`    ${this.muted(`nothing matches "${query}"`)}`);
      page.forEach((ch, i) => {
        if (!query && ch.group && ch.group !== lastGroup) {
          lines.push(`    ${this.muted(ch.group.toUpperCase())}`);
          lastGroup = ch.group;
        }
        const active = top + i === cursor;
        const pointer = active ? this.accent("❯") : " ";
        const nm = fit(ch.label, labelW - 1);
        const name = nm + " ".repeat(Math.max(1, labelW - stringWidth(nm)));
        const badge = ch.badge ? fit(ch.badge, 28) : "";
        const hintW = w - 6 - labelW - (badge ? stringWidth(badge) + 2 : 0);
        const hint = ch.hint ? fit(ch.hint, hintW) : "";
        const gap = Math.max(1, w - 6 - labelW - stringWidth(hint) - stringWidth(badge));
        const tone = ch.badgeTone === "ok" ? this.okc : ch.badgeTone === "warn" ? this.accent : this.muted;
        lines.push(`  ${pointer} ${active ? this.bold(name) : name}${this.muted(hint)}${badge ? " ".repeat(gap) + tone(badge) : ""}`);
      });
      const more = list.length > pageSize ? `${top + 1}–${Math.min(list.length, top + pageSize)} of ${list.length} · ` : "";
      lines.push(`    ${this.muted(`${more}↑↓ move · enter select${o.back ? " · esc back" : ""}${o.footer ? ` · ${o.footer}` : ""}`)}`);
      this.draw(lines);
    };

    const result = await this.keys<T | Back>((str, key, finish) => {
      const list = visible();
      if (key.name === "return") {
        if (list[cursor]) finish(list[cursor]!.value);
        return;
      }
      if (key.name === "escape") {
        if (query) query = "";
        else if (o.back) return finish(BACK);
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) cursor = (cursor - 1 + list.length) % Math.max(1, list.length);
      else if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab") cursor = (cursor + 1) % Math.max(1, list.length);
      else if (key.name === "pageup") cursor = Math.max(0, cursor - pageSize);
      else if (key.name === "pagedown") cursor = Math.min(list.length - 1, cursor + pageSize);
      else if (key.name === "backspace") {
        query = query.slice(0, -1);
        cursor = 0;
      } else if (o.filter !== false && str && str.length === 1 && str >= " " && !key.ctrl && !key.meta) {
        query += str;
        cursor = 0;
        top = 0;
      }
      render();
    }, render);
    if (result === BACK) this.done(`  ${this.muted("‹")} ${this.muted(o.message)}`);
    else this.done(`  ${this.okc("✓")} ${o.message} ${this.accent(o.choices.find((ch) => ch.value === result)?.label ?? String(result))}`);
    return result;
  }

  // ------------------------------------------------------------ text

  async text(o: { message: string; initial?: string; placeholder?: string; secret?: boolean; optional?: boolean; back?: boolean; validate?: (v: string) => string | null; hint?: string }): Promise<string | Back> {
    if (!this.interactive) {
      for (;;) {
        const a = (await this.line(`  ${o.message}${o.initial ? this.muted(` [${o.secret ? "•••" : o.initial}]`) : ""} `, o.secret)) || o.initial || "";
        const err = !a && !o.optional ? "A value is required." : a ? (o.validate?.(a) ?? null) : null;
        if (!err) return a;
        throw new Error(err);
      }
    }
    let value = "";
    let error: string | null = null;
    const render = () => {
      const shown = o.secret ? "•".repeat(value.length) : value;
      const ph = !value ? this.muted(o.placeholder ?? o.initial ?? "") : "";
      const lines = [`  ${this.accent("?")} ${this.bold(o.message)} ${shown}${ph}${this.accent("▏")}`];
      if (error) lines.push(`    ${this.errc(error)}`);
      else lines.push(`    ${this.muted(`${o.hint ? `${o.hint} · ` : ""}enter ${o.optional && !o.initial ? "(empty to skip)" : "to confirm"}${o.back ? " · esc back" : ""}`)}`);
      this.draw(lines);
    };
    const result = await this.keys<string | Back>((str, key, finish) => {
      if (key.name === "return") {
        const v = value.trim() || o.initial || "";
        if (!v && !o.optional) error = "A value is required.";
        else {
          error = v ? (o.validate?.(v) ?? null) : null;
          if (!error) return finish(v);
        }
      } else if (key.name === "escape") {
        if (o.back) return finish(BACK);
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (key.ctrl && key.name === "u") value = "";
      else if (str && !key.ctrl && !key.meta) {
        // Pasted text arrives as one string; keep printable characters only.
        const printable = [...str].filter((ch) => ch >= " " && ch !== "\u007f").join("");
        value += printable;
        error = null;
      }
      render();
    }, render);
    if (result === BACK) this.done(`  ${this.muted("‹")} ${this.muted(o.message)}`);
    else this.done(`  ${this.okc("✓")} ${o.message} ${this.accent(o.secret ? (result ? `${"•".repeat(Math.min(8, result.length))} (${result.length} characters)` : "none") : result || "none")}`);
    return result;
  }

  // ------------------------------------------------------------ confirm

  async confirm(o: { message: string; initial?: boolean }): Promise<boolean> {
    const def = o.initial ?? true;
    if (!this.interactive) {
      const a = await this.line(`  ${o.message} ${this.muted(def ? "[Y/n]" : "[y/N]")} `);
      return a ? /^y(es)?$/i.test(a) : def;
    }
    let v = def;
    const render = () => this.draw([`  ${this.accent("?")} ${this.bold(o.message)} ${v ? this.accent(this.c.underline("Yes")) : this.muted("Yes")} ${this.muted("/")} ${!v ? this.accent(this.c.underline("No")) : this.muted("No")}`]);
    const result = await this.keys<boolean>((str, key, finish) => {
      if (key.name === "return") return finish(v);
      if (str === "y" || str === "Y") return finish(true);
      if (str === "n" || str === "N" || key.name === "escape") return finish(false);
      if (["left", "right", "tab", "up", "down"].includes(key.name ?? "")) v = !v;
      render();
    }, render);
    this.done(`  ${this.okc("✓")} ${o.message} ${this.accent(result ? "Yes" : "No")}`);
    return result;
  }

  // ------------------------------------------------------------ spinner

  async spin<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (!this.interactive) {
      this.write(`  … ${label}`);
      return task();
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    this.out.write("\u001b[?25l");
    const draw = () => this.out.write(`\u001b[1G\u001b[2K  ${this.accent(frames[i++ % frames.length]!)} ${label}`);
    draw();
    const timer = setInterval(draw, 80);
    try {
      return await task();
    } finally {
      clearInterval(timer);
      this.out.write("\u001b[1G\u001b[2K\u001b[?25h");
    }
  }

  /** A framed block of label/value rows. */
  box(title: string, rows: [string, string][], tone: "ok" | "warn" = "ok"): void {
    const lw = Math.max(...rows.map(([l]) => stringWidth(l)));
    const max = this.width - 8;
    // Values are cut to fit (colour codes are dropped from a cut value).
    const body = rows.map(([l, v]) => {
      const line = `${this.muted(l.padEnd(lw))}   ${v}`;
      return stringWidth(strip(line)) <= max ? line : `${this.muted(l.padEnd(lw))}   ${fit(strip(v), max - lw - 3)}`;
    });
    const inner = Math.min(max, Math.max(stringWidth(title) + 2, ...body.map((b) => stringWidth(strip(b))))) + 1;
    const col = tone === "ok" ? this.okc : this.accent;
    this.write(`  ${col("╭─")} ${col(this.bold(title))} ${col("─".repeat(Math.max(0, inner - stringWidth(title) - 2)))}${col("╮")}`);
    for (const b of body) {
      const pad = Math.max(0, inner - stringWidth(strip(b)));
      this.write(`  ${col("│")} ${b}${" ".repeat(pad)}${col("│")}`);
    }
    this.write(`  ${col("╰")}${col("─".repeat(inner + 1))}${col("╯")}`);
  }
}
