import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface ProcessResult {
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** True if stdout/stderr exceeded the in-memory capture limit. */
  outputTruncated: boolean;
  logPath?: string;
}

export interface RunOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Max characters kept in memory per stream (head + tail). */
  captureLimit?: number;
  /** Write the complete combined output here. */
  logPath?: string;
  onData?: (stream: "stdout" | "stderr", chunk: string) => void;
  shell?: string;
  /** Used for argument-vector execution without a shell (e.g. git). */
  argv?: string[];
}

/** Head+tail ring buffer so huge outputs can't exhaust memory. */
class BoundedCapture {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(private readonly limit: number) {}
  push(s: string): void {
    this.total += s.length;
    const headLimit = Math.floor(this.limit / 2);
    if (this.head.length < headLimit) {
      const take = s.slice(0, headLimit - this.head.length);
      this.head += take;
      s = s.slice(take.length);
    }
    if (s.length) this.tail = (this.tail + s).slice(-(this.limit - headLimit));
  }
  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length;
  }
  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    const omitted = this.total - this.head.length - this.tail.length;
    return `${this.head}\n… [${omitted} characters not captured] …\n${this.tail}`;
  }
}

const KILL_GRACE_MS = 2000;

/**
 * Run a command in its own process group so timeouts and cancellation kill
 * the whole tree, not just the shell.
 */
export function runProcess(opts: RunOptions): Promise<ProcessResult> {
  const startedAt = new Date();
  const limit = opts.captureLimit ?? 1_000_000;
  const out = new BoundedCapture(limit);
  const err = new BoundedCapture(limit);
  let log: WriteStream | undefined;
  if (opts.logPath) {
    mkdirSync(dirname(opts.logPath), { recursive: true, mode: 0o700 });
    log = createWriteStream(opts.logPath, { mode: 0o600 });
    log.write(`$ ${opts.command}\n# cwd: ${opts.cwd}\n# started: ${startedAt.toISOString()}\n\n`);
  }

  return new Promise((resolve) => {
    const [file, args] = opts.argv
      ? [opts.argv[0]!, opts.argv.slice(1)]
      : [opts.shell ?? "/bin/sh", ["-c", opts.command]];
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const terminate = () => {
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out.push(d);
      log?.write(d);
      opts.onData?.("stdout", d);
    });
    child.stderr!.on("data", (d: string) => {
      err.push(d);
      log?.write(d);
      opts.onData?.("stderr", d);
    });

    const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) err.push(`spawn error: ${spawnError.message}\n`);
      const endedAt = new Date();
      log?.end(`\n# exit: ${code ?? sig}${timedOut ? " (timeout)" : ""}${cancelled ? " (cancelled)" : ""}\n`);
      resolve({
        command: opts.command,
        cwd: opts.cwd,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode: code,
        signal: sig,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        cancelled,
        outputTruncated: out.truncated || err.truncated,
        ...(opts.logPath ? { logPath: opts.logPath } : {}),
      });
    };
    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

let rgAvailable: boolean | undefined;
/** Detects a real ripgrep binary on PATH (shell functions/aliases don't count). */
export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  if (process.env.SUTRA_DISABLE_RG === "1") return (rgAvailable = false);
  const r = await runProcess({ command: "rg --version", argv: ["rg", "--version"], cwd: process.cwd(), timeoutMs: 3000 });
  rgAvailable = r.exitCode === 0 && r.stdout.startsWith("ripgrep");
  return rgAvailable;
}
