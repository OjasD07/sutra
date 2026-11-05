import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlanStore } from "../../src/core/planning/plan.js";
import { assessCommand } from "../../src/permissions/commands.js";
import { Workspace } from "../../src/permissions/paths.js";
import { SecretRedactor } from "../../src/permissions/sensitive.js";
import { bubblewrapArgs, createSandbox, probeSandbox, seatbeltProfile, type SandboxRunner } from "../../src/sandbox/sandbox.js";
import { FileStateTracker } from "../../src/tools/file-state.js";
import { createDefaultRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";
import { tempDir, writeFiles } from "../helpers/harness.js";

const exec = createDefaultRegistry().get("execute_command")!;

function ctx(root: string, sandbox: SandboxRunner | null, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: new Workspace(root),
    fileState: new FileStateTracker(),
    plan: new PlanStore(),
    redactor: new SecretRedactor(),
    signal: new AbortController().signal,
    sessionId: "s",
    toolCallId: "c",
    settings: { commandTimeoutMs: 20_000, maxOutputChars: 20_000, retainFullLogs: false, scrubEnv: true, logDir: join(root, ".logs") },
    sandbox,
    ...extra,
  };
}

describe("sandbox policy generation", () => {
  it("builds a Seatbelt profile that confines writes, hides credentials and blocks the network", () => {
    const p = seatbeltProfile({ workspace: "/work/repo", allowWrite: ["/opt/extra"], network: false });
    expect(p).toContain("(deny file-write*)");
    expect(p).toMatch(/\(allow file-write\* \(subpath "\/work\/repo"\)/);
    expect(p).toContain('(subpath "/opt/extra")');
    expect(p).toContain(`(subpath "${join(homedir(), ".ssh")}")`);
    expect(p).toContain("(deny network-outbound (remote ip))");
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(seatbeltProfile({ workspace: "/w", allowWrite: [], network: true })).not.toContain("deny network-outbound");
  });

  it("escapes paths in the profile", () => {
    expect(seatbeltProfile({ workspace: '/tmp/a "b"\\c', allowWrite: [], network: false })).toContain('(subpath "/tmp/a \\"b\\"\\\\c")');
  });

  it("builds bubblewrap arguments with a read-only root and no network", () => {
    const args = bubblewrapArgs("npm test", "/work/repo", { workspace: "/work/repo", allowWrite: [], network: false });
    expect(args.slice(0, 4)).toEqual(["bwrap", "--ro-bind", "/", "/"]);
    expect(args).toContain("--unshare-net");
    expect(args.slice(-5)).toEqual(["--chdir", "/work/repo", "/bin/sh", "-c", "npm test"]);
    expect(bubblewrapArgs("x", "/w", { workspace: "/w", allowWrite: [], network: true })).not.toContain("--unshare-net");
  });

  it("reports unavailable / off states honestly", () => {
    expect(createSandbox("off", { workspace: "/w", allowWrite: [], network: false }).runner).toBeNull();
    const none = createSandbox("auto", { workspace: "/w", allowWrite: [], network: false }, () => ({ backend: null, reason: "no backend" }));
    expect(none).toMatchObject({ runner: null, reason: "no backend" });
  });

  it("refuses to run commands when the sandbox is required but missing", async () => {
    const root = tempDir();
    const r = await exec.execute(exec.schema.parse({ command: "echo hi" }), ctx(root, null, { sandboxRequired: true }));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/required/);
  });

  it("flags network needs separately from overall risk", () => {
    expect(assessCommand("npm install left-pad").network).toBe(true);
    expect(assessCommand("git push origin main")).toMatchObject({ risk: "destructive", network: true });
    expect(assessCommand("npm test").network).toBe(false);
  });
});

const backend = probeSandbox().backend;

describe.skipIf(!backend)(`live OS sandbox (${backend ?? "unavailable"})`, () => {
  const root = tempDir("sutra-sbx-");
  writeFiles(root, { "a.txt": "hello\n" });
  const outside = join(process.cwd(), `.sutra-sandbox-probe-${process.pid}`);
  const runner = createSandbox("required", { workspace: root, allowWrite: [], network: false }).runner!;
  const run = async (command: string, extra: Partial<ToolContext> = {}) => exec.execute(exec.schema.parse({ command }), ctx(root, runner, extra));

  it("lets commands work inside the workspace", async () => {
    const r = await run("cat a.txt && echo more > b.txt && cat b.txt");
    expect(r.data?.exitCode).toBe(0);
    expect(r.output).toContain("hello");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("more\n");
    expect(r.output).toContain("sandbox:");
  });

  it("blocks writes outside the workspace", async () => {
    const r = await run(`echo pwned > ${outside}`);
    expect(r.data?.exitCode).not.toBe(0);
    expect(r.output).toMatch(/Operation not permitted|Read-only file system|Permission denied/);
    expect(existsSync(outside)).toBe(false);
  });

  it("hides credential directories", async () => {
    const r = await run("ls ~/.ssh ~/.aws ~/.sutra 2>&1; echo done");
    expect(r.output).not.toMatch(/id_rsa|id_ed25519|known_hosts|credentials\b/);
  });

  it("blocks outbound network unless the call was approved as a network command", async () => {
    const probe = `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('CONNECTED');process.exit()}).on('error',e=>{console.log('ERR',e.code);process.exit()})"`;
    const blocked = await run(probe);
    const stdout = blocked.output.split("--- stdout ---")[1] ?? "";
    expect(stdout).toMatch(/ERR (EPERM|ENETUNREACH|EACCES)/);
    expect(stdout).not.toContain("CONNECTED");
  });

  it("still allows loopback (local test servers)", async () => {
    const r = await run(`node -e "const s=require('net').createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>{require('net').connect(s.address().port,'127.0.0.1').on('data',d=>{console.log(String(d));process.exit()})})"`);
    expect(r.output).toContain("pong");
  });
});
