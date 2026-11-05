import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * OS-level isolation for shell commands and test runs.
 *
 * This is a second layer under the approval gate: even an approved command
 * can only write inside the workspace (plus temp and package-manager cache
 * directories), cannot read common credential stores, and has no outbound
 * network unless the command was approved as a network command.
 *
 *  - macOS: Seatbelt via /usr/bin/sandbox-exec with a generated SBPL profile.
 *  - Linux: bubblewrap (bwrap) when installed: read-only root, writable binds
 *    for allowed paths, credential dirs masked, separate network namespace.
 *  - Elsewhere, or without bwrap: unavailable (mode "auto" falls back to the
 *    approval gate only and says so; mode "required" refuses to run commands).
 */
export type SandboxBackendName = "seatbelt" | "bubblewrap";

export interface SandboxPolicy {
  workspace: string;
  /** Additional writable directories. */
  allowWrite: string[];
  /** Allow all outbound network (otherwise only loopback). */
  network: boolean;
}

export interface SandboxRunner {
  backend: SandboxBackendName;
  /** Human-readable summary for the UI ("macOS Seatbelt · network off"). */
  describe(network: boolean): string;
  /** argv that runs `command` under the sandbox via /bin/sh -c. */
  wrap(command: string, cwd: string, network: boolean): string[];
}

export interface SandboxStatus {
  mode: "auto" | "required" | "off";
  runner: SandboxRunner | null;
  /** Why there is no runner (when mode is not off). */
  reason?: string;
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

const HOME = () => homedir();

/** Writable caches that common toolchains need even for read-only work (npm writes logs on every run). */
export function defaultCacheDirs(home = HOME()): string[] {
  return [".npm", ".cache", ".yarn", ".bun", ".pnpm-store", "Library/Caches", "Library/pnpm", ".cargo/registry", "go/pkg/mod"].map((d) => join(home, d));
}

/** Credential stores no sandboxed command may read. */
export function deniedReadDirs(home = HOME()): string[] {
  return [".ssh", ".aws", ".gnupg", ".sutra", ".config/gh", ".docker", ".kube", ".netrc", ".git-credentials", ".npmrc", ".pypirc", "Library/Keychains"].map((d) => join(home, d));
}

function writableDirs(policy: SandboxPolicy): string[] {
  const dirs = [policy.workspace, tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", ...defaultCacheDirs(), ...policy.allowWrite];
  return [...new Set(dirs.map(real))];
}

/** Escape a string for an SBPL "..." literal. */
function sbpl(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    ";; writes only where the work happens",
    "(deny file-write*)",
    `(allow file-write* ${writableDirs(policy).map((d) => `(subpath ${sbpl(d)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ";; no access to credential stores",
    `(deny file-read* file-write* ${deniedReadDirs().map((d) => `(subpath ${sbpl(real(d))})`).join(" ")})`,
  ];
  if (!policy.network) {
    lines.push(";; no outbound network except loopback", "(deny network-outbound (remote ip))", '(allow network-outbound (remote ip "localhost:*"))');
  }
  return lines.join("\n") + "\n";
}

export function bubblewrapArgs(command: string, cwd: string, policy: SandboxPolicy): string[] {
  const args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const d of writableDirs(policy)) if (existsSync(d)) args.push("--bind", d, d);
  for (const d of deniedReadDirs()) if (existsSync(d)) args.push(...(d.endsWith(".netrc") || d.endsWith("credentials") || d.endsWith(".npmrc") || d.endsWith(".pypirc") ? ["--ro-bind", "/dev/null", d] : ["--tmpfs", d]));
  if (!policy.network) args.push("--unshare-net");
  args.push("--chdir", cwd, "/bin/sh", "-c", command);
  return args;
}

function hasBinary(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let probed: { backend: SandboxBackendName | null; reason?: string } | undefined;

/** Find a working sandbox on this machine (probed once, by actually running one). */
export function probeSandbox(): { backend: SandboxBackendName | null; reason?: string } {
  if (probed) return probed;
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return (probed = { backend: null, reason: "sandbox-exec not found" });
    try {
      execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
      return (probed = { backend: "seatbelt" });
    } catch {
      return (probed = { backend: null, reason: "sandbox-exec is present but cannot apply a profile here (already inside a sandbox?)" });
    }
  }
  if (process.platform === "linux") {
    if (!hasBinary("bwrap")) return (probed = { backend: null, reason: "bubblewrap (bwrap) is not installed" });
    try {
      execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "/bin/true"], { stdio: "ignore", timeout: 5000 });
      return (probed = { backend: "bubblewrap" });
    } catch {
      return (probed = { backend: null, reason: "bwrap is installed but cannot create a sandbox (user namespaces disabled?)" });
    }
  }
  return (probed = { backend: null, reason: `no sandbox backend for ${process.platform}` });
}

export function createSandbox(mode: "auto" | "required" | "off", policy: Omit<SandboxPolicy, "network"> & { network: boolean }, probe = probeSandbox): SandboxStatus {
  if (mode === "off") return { mode, runner: null };
  const found = probe();
  if (!found.backend) return { mode, runner: null, ...(found.reason ? { reason: found.reason } : {}) };
  const backend = found.backend;
  const runner: SandboxRunner = {
    backend,
    describe: (network) =>
      `${backend === "seatbelt" ? "macOS Seatbelt" : "bubblewrap"} · writes: workspace + temp · network ${network || policy.network ? "on" : "off"}`,
    wrap: (command, cwd, network) => {
      const p = { ...policy, network: policy.network || network };
      return backend === "seatbelt" ? ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(p), "/bin/sh", "-c", command] : bubblewrapArgs(command, cwd, p);
    },
  };
  return { mode, runner };
}

export function sandboxSummary(s: SandboxStatus): string {
  if (s.mode === "off") return "off (approval gate only)";
  if (!s.runner) return `unavailable — ${s.reason ?? "unknown"} (approval gate only)`;
  return s.runner.describe(false);
}
