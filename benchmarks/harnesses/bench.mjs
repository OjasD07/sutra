#!/usr/bin/env node
// Cross-harness benchmark: the same tasks, model, prompt, timeout and API
// key for every coding agent, measured by one metering proxy and judged by
// each task's own test command.
//
//   node benchmarks/harnesses/bench.mjs check                 # which harnesses are installed, flags present
//   node benchmarks/harnesses/bench.mjs selftest              # offline test of the pipeline (no API spend)
//   node benchmarks/harnesses/bench.mjs run [options]         # the benchmark
//
// See README.md next to this file.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ADAPTERS, SELFTEST_ADAPTER } from "./adapters.mjs";
import { startProxy } from "./proxy.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "..", "..");

// USD per 1M tokens, from DeepSeek's pricing page (2026-11-05). Override with --prices <file.json>.
const PEAK_WINDOWS_UTC = [
  { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
  { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
];
const DEFAULT_PRICES = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2, offPeak: { hit: 0.003, miss: 0.15, out: 0.6 } },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96, offPeak: { hit: 0.022, miss: 0.66, out: 1.98 } },
};

// ------------------------------------------------------------------ helpers

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const usd = (x) => (x === null || x === undefined ? "—" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const num = (x) => (x === null || x === undefined ? "—" : Math.round(x).toLocaleString("en-US"));
const secs = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);

function isPeak(date) {
  const day = date.getUTCDay();
  const hm = date.toISOString().slice(11, 16);
  return PEAK_WINDOWS_UTC.some((w) => w.days.includes(day) && hm >= w.start && hm < w.end);
}

function requestCost(r, prices, fallbackModel) {
  const p = prices[r.model] ?? prices[fallbackModel];
  if (!p) return null;
  const rate = isPeak(new Date(r.at)) || !p.offPeak ? p : { ...p, ...p.offPeak };
  const hit = Math.min(r.cached, r.input);
  return (hit * rate.hit + (r.input - hit) * rate.miss + r.output * rate.out) / 1e6;
}

function findKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: "DEEPSEEK_API_KEY" };
  const f = join(process.env.SUTRA_HOME ?? join(homedir(), ".sutra"), "credentials.json");
  if (existsSync(f)) {
    try {
      const k = JSON.parse(readFileSync(f, "utf8")).deepseekApiKey;
      if (typeof k === "string" && k) return { key: k, from: f };
    } catch {
      /* unreadable */
    }
  }
  return null;
}

function which(bin) {
  if (bin.startsWith("/")) return existsSync(bin) ? bin : null;
  const r = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function loadTasks(dir, only) {
  const tasks = [];
  for (const id of readdirSync(dir).sort()) {
    const f = join(dir, id, "task.json");
    if (!existsSync(f)) continue;
    if (only && !only.includes(id)) continue;
    tasks.push({ id, dir: join(dir, id), ...JSON.parse(readFileSync(f, "utf8")) });
  }
  return tasks;
}

function hashTree(root, rel) {
  const h = createHash("sha256");
  const walk = (p) => {
    if (!existsSync(p)) return h.update(`missing:${relative(root, p)}`);
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
    else h.update(relative(root, p)).update(readFileSync(p));
  };
  walk(join(root, rel));
  return h.digest("hex");
}

const GIT = ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd, ...args) => spawnSync("git", [...GIT, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });

/** Run a child in its own process group; kill the whole group on timeout. */
function runChild(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    const cap = (s, c) => (s.length < 4_000_000 ? s + c : s);
    child.stdout.on("data", (c) => (out = cap(out, c.toString())));
    child.stderr.on("data", (c) => (err = cap(err, c.toString())));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }, 5000).unref();
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, timedOut, stdout: out, stderr: err + String(e), ms: Date.now() - started, spawnError: String(e.message ?? e) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, signal, timedOut, stdout: out, stderr: err, ms: Date.now() - started });
    });
  });
}

// --------------------------------------------------------------------- run

async function runOne({ harnessId, adapter, task, trial, model, key, prices, outDir, timeoutMs, upstream, keep, sandboxSutra, selftestFix }) {
  const work = mkdtempSync(join(tmpdir(), `hb-${harnessId}-${task.id}-`));
  const home = mkdtempSync(join(tmpdir(), `hb-home-`));
  cpSync(join(task.dir, "repo"), work, { recursive: true });
  git(work, "init", "-q");
  writeFileSync(join(work, ".git", "info", "exclude"), ".aider*\n.claude/\n.codex/\n.opencode/\n.goose/\n.qwen/\n.sutra/\nnode_modules/\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "task start");
  const protectedPaths = task.protected ?? [];
  const before = Object.fromEntries(protectedPaths.map((p) => [p, hashTree(work, p)]));

  const proxy = await startProxy({ upstream });
  const ctx = { home, work, proxyUrl: proxy.url, model, anthropicModel: model, key, prompt: task.prompt, sandboxSutra, selftestFix };
  const prep = adapter.prepare(ctx);
  const bin = prep.bin ?? which(adapter.bin) ?? adapter.bin;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER ?? "bench",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    TMPDIR: tmpdir(),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ...prep.env,
  };
  const r = await runChild(bin, prep.args, { cwd: work, env, timeoutMs });
  await proxy.close();

  // Tampering: protected paths (the tests) changed by the agent. Restore them before judging.
  const tampered = protectedPaths.filter((p) => hashTree(work, p) !== before[p]);
  for (const p of protectedPaths) {
    rmSync(join(work, p), { recursive: true, force: true });
    if (existsSync(join(task.dir, "repo", p))) cpSync(join(task.dir, "repo", p), join(work, p), { recursive: true });
  }
  git(work, "add", "-A");
  const numstat = git(work, "diff", "--cached", "--numstat", "HEAD").stdout.trim();
  const changed = numstat ? numstat.split("\n").map((l) => l.split("\t")) : [];
  const linesAdded = changed.reduce((a, [x]) => a + (Number(x) || 0), 0);
  const linesRemoved = changed.reduce((a, [, y]) => a + (Number(y) || 0), 0);

  const v = spawnSync("/bin/sh", ["-c", task.verify], { cwd: work, encoding: "utf8", timeout: 180_000, env: { PATH: process.env.PATH, HOME: home, CI: "1", NO_COLOR: "1" } });

  const reqs = proxy.requests;
  const costs = reqs.map((q) => requestCost(q, prices, model));
  const sum = (k) => reqs.reduce((a, q) => a + (q[k] ?? 0), 0);
  const result = {
    harness: harnessId,
    task: task.id,
    trial,
    passed: v.status === 0,
    verifyExitCode: v.status,
    harnessExitCode: r.exitCode,
    timedOut: r.timedOut,
    spawnError: r.spawnError ?? null,
    wallMs: r.ms,
    requests: reqs.length,
    failedRequests: reqs.filter((q) => q.status >= 400).length,
    // Only model calls are billed; GET requests (such as listing models) carry no usage by design.
    requestsWithoutUsage: reqs.filter((q) => q.method === "POST" && q.status < 400 && !q.usageFound).length,
    inputTokens: sum("input"),
    cachedInputTokens: sum("cached"),
    outputTokens: sum("output"),
    reasoningTokens: sum("reasoning"),
    costUsd: costs.reduce((a, c) => a + (c ?? 0), 0),
    costComplete: costs.every((c) => c !== null),
    modelTimeMs: sum("ms"),
    tamperedProtected: tampered,
    filesChanged: changed.map((c) => c[2]),
    linesAdded,
    linesRemoved,
    errorSample: reqs.find((q) => q.errorBody)?.errorBody ?? null,
  };

  const logDir = join(outDir, "logs", harnessId);
  mkdirSync(logDir, { recursive: true });
  const scrub = (s) => (key ? s.split(key).join("[DEEPSEEK_API_KEY]") : s);
  const base = join(logDir, `${task.id}-t${trial}`);
  writeFileSync(`${base}.stdout.txt`, scrub(r.stdout));
  writeFileSync(`${base}.stderr.txt`, scrub(r.stderr));
  writeFileSync(`${base}.verify.txt`, scrub((v.stdout ?? "") + (v.stderr ?? "")));
  writeFileSync(`${base}.requests.json`, scrub(JSON.stringify(reqs, null, 2)));
  writeFileSync(`${base}.diff`, scrub(git(work, "diff", "--cached", "HEAD").stdout));

  if (!keep) {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  } else result.workspace = work;
  return result;
}

function aggregate(results, harnessIds, tasks) {
  const rows = [];
  for (const h of harnessIds) {
    const rs = results.filter((r) => r.harness === h);
    if (!rs.length) continue;
    const passes = rs.filter((r) => r.passed);
    const byTask = tasks.map((t) => rs.filter((r) => r.task === t.id));
    const withRuns = byTask.filter((x) => x.length);
    const trialRates = [...new Set(rs.map((r) => r.trial))].map((tr) => {
      const x = rs.filter((r) => r.trial === tr);
      return x.filter((r) => r.passed).length / x.length;
    });
    const totalCost = rs.reduce((a, r) => a + r.costUsd, 0);
    const input = rs.reduce((a, r) => a + r.inputTokens, 0);
    const cached = rs.reduce((a, r) => a + r.cachedInputTokens, 0);
    const billedTokens = rs.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
    rows.push({
      harness: h,
      name: ADAPTERS[h]?.name ?? h,
      runs: rs.length,
      passRate: passes.length / rs.length,
      passRateStdevAcrossTrials: stdev(trialRates),
      passAtK: withRuns.filter((x) => x.some((r) => r.passed)).length / (withRuns.length || 1),
      passAllK: withRuns.filter((x) => x.every((r) => r.passed)).length / (withRuns.length || 1),
      falseSuccess: rs.filter((r) => !r.passed && r.harnessExitCode === 0 && !r.timedOut).length,
      tamperRate: rs.filter((r) => r.tamperedProtected.length).length / rs.length,
      timeouts: rs.filter((r) => r.timedOut).length,
      errors: rs.filter((r) => r.spawnError || (r.requests > 0 && r.failedRequests === r.requests) || r.requests === 0).length,
      medianWallMs: median(rs.map((r) => r.wallMs)),
      meanWallMs: mean(rs.map((r) => r.wallMs)),
      medianModelTimeMs: median(rs.map((r) => r.modelTimeMs)),
      totalCostUsd: totalCost,
      meanCostUsd: totalCost / rs.length,
      costPerPassUsd: passes.length ? totalCost / passes.length : null,
      costComplete: rs.every((r) => r.costComplete),
      meanRequests: mean(rs.map((r) => r.requests)),
      meanInputTokens: input / rs.length,
      meanOutputTokens: rs.reduce((a, r) => a + r.outputTokens, 0) / rs.length,
      meanReasoningTokens: rs.reduce((a, r) => a + r.reasoningTokens, 0) / rs.length,
      cacheHitRate: input ? cached / input : 0,
      passesPerMillionTokens: billedTokens ? (passes.length / billedTokens) * 1e6 : 0,
      meanLinesChanged: mean(rs.map((r) => r.linesAdded + r.linesRemoved)),
      meanFilesChanged: mean(rs.map((r) => r.filesChanged.length)),
      requestsWithoutUsage: rs.reduce((a, r) => a + r.requestsWithoutUsage, 0),
      perTask: Object.fromEntries(tasks.map((t, i) => [t.id, byTask[i].length ? `${byTask[i].filter((r) => r.passed).length}/${byTask[i].length}` : "—"])),
    });
  }
  return rows.sort((a, b) => b.passRate - a.passRate || (a.costPerPassUsd ?? Infinity) - (b.costPerPassUsd ?? Infinity));
}

function markdown(report) {
  const { rows, tasks, meta } = report;
  const lines = [
    `# Harness benchmark — ${meta.model} · ${meta.startedAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    `${meta.tasks} task(s) × ${meta.trials} trial(s) per harness · timeout ${secs(meta.timeoutMs)} · same prompt, model, key and metering proxy for every harness · judged by each task's own test command after restoring protected files.`,
    "",
    "| Harness | Pass | pass@k | pass^k | False success | Tamper | Median time | Cost / run | Cost / pass | Passes per 1M tok | Input tok / run | Cache hit | Output tok / run | Requests / run | Lines changed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${pct(r.passRate)}${r.passRateStdevAcrossTrials ? ` ±${Math.round(r.passRateStdevAcrossTrials * 100)}` : ""} | ${pct(r.passAtK)} | ${pct(r.passAllK)} | ${r.falseSuccess} | ${pct(r.tamperRate)} | ${secs(r.medianWallMs)} | ${usd(r.meanCostUsd)}${r.costComplete ? "" : "+"} | ${usd(r.costPerPassUsd)} | ${r.passesPerMillionTokens.toFixed(2)} | ${num(r.meanInputTokens)} | ${pct(r.cacheHitRate)} | ${num(r.meanOutputTokens)} | ${(r.meanRequests ?? 0).toFixed(1)} | ${(r.meanLinesChanged ?? 0).toFixed(0)} |`,
    ),
    "",
    "## Per task (passes / runs)",
    "",
    `| Harness | ${tasks.map((t) => t.id).join(" | ")} |`,
    `| --- | ${tasks.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.name} | ${tasks.map((t) => r.perTask[t.id]).join(" | ")} |`),
    "",
    "## Notes",
    "",
    "- **Pass**: share of runs whose task tests pass; ± is the standard deviation of the pass rate across trials. **pass@k**: tasks solved in at least one trial. **pass^k**: tasks solved in every trial.",
    "- **False success**: the harness exited 0 but the tests fail. **Tamper**: runs that modified protected files (the tests); they are restored before judging.",
    "- Tokens, cache hits and cost come from the provider's usage fields as seen by the metering proxy, priced at DeepSeek's peak/off-peak rates for the time of each request.",
    ...(rows.some((r) => r.requestsWithoutUsage) ? [`- ${rows.filter((r) => r.requestsWithoutUsage).map((r) => `${r.name}: ${r.requestsWithoutUsage}`).join(", ")} successful request(s) carried no usage data, so those harnesses' token and cost numbers are lower bounds.`] : []),
    ...(rows.some((r) => r.errors) ? [`- Runs that errored before doing work (could not start, or every model request failed): ${rows.filter((r) => r.errors).map((r) => `${r.name} ${r.errors}`).join(", ")}. See logs/ — usually a CLI flag or provider-config mismatch, not a model failure.`] : []),
  ];
  return lines.join("\n") + "\n";
}

function csv(results) {
  const cols = ["harness", "task", "trial", "passed", "verifyExitCode", "harnessExitCode", "timedOut", "wallMs", "modelTimeMs", "requests", "failedRequests", "requestsWithoutUsage", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "costUsd", "linesAdded", "linesRemoved", "filesChanged", "tamperedProtected"];
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join(";") : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

// ------------------------------------------------------------------ commands

function check(ids) {
  log("Harness       Installed  Version                         Flags missing from --help");
  const out = {};
  for (const id of ids) {
    const a = ADAPTERS[id];
    const path = which(a.bin);
    if (!path) {
      log(`${id.padEnd(13)} no         —                               install: ${a.install}`);
      out[id] = { installed: false };
      continue;
    }
    const version = id.startsWith("sutra") ? "this repo" : (spawnSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "").trim().split("\n")[0];
    const helps = a.helpArgs ? [a.helpArgs] : [["--help"], ...(a.flags[0] && !a.flags[0].startsWith("-") ? [[a.flags[0], "--help"]] : [])];
    const help = helps.map((h) => {
      const r = spawnSync(path, h, { encoding: "utf8", timeout: 20_000 });
      return (r.stdout ?? "") + (r.stderr ?? "");
    }).join("\n");
    const missing = a.flags.filter((f) => !new RegExp(`(^|[\\s,\\[])${f.replace(/[-]/g, "\\-")}([\\s,=\\]<]|$)`, "m").test(help));
    out[id] = { installed: true, path, version, missing };
    log(`${id.padEnd(13)} yes        ${version.slice(0, 30).padEnd(31)} ${missing.length ? missing.join(" ") : "none"}`);
  }
  log("\nSources for each adapter's flags and provider settings:");
  for (const id of ids) log(`  ${id}: ${ADAPTERS[id].sources}`);
  return out;
}

async function selftest() {
  // A fake DeepSeek: streams an OpenAI-style reply with a usage chunk.
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!body.stream_options?.include_usage) {
      res.writeHead(400).end('{"error":"proxy did not request usage"}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_cache_hit_tokens":800,"completion_tokens_details":{"reasoning_tokens":10}}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const outDir = mkdtempSync(join(tmpdir(), "hb-selftest-"));
  const task = loadTasks(join(ROOT, "benchmarks", "tasks"), ["session-expiry"])[0];
  const common = { harnessId: "selftest", adapter: SELFTEST_ADAPTER, task, model: "deepseek-flash", key: "sk-selftest-0000", prices: DEFAULT_PRICES, outDir, timeoutMs: 60_000, upstream, keep: false };
  const fixed = await runOne({ ...common, trial: 1, selftestFix: `sed -i.bak 's/return session.expiresAt < now;/return session.expiresAt * 1000 <= now;/' src/session.js && rm src/session.js.bak` });
  const cheat = await runOne({ ...common, trial: 2, selftestFix: "printf 'import test from \"node:test\";\\ntest(\"ok\", () => {});\\n' > test/session.test.js" });
  mock.close();
  const checks = [
    ["fixed run passes", fixed.passed === true],
    ["usage parsed from the stream", fixed.inputTokens === 1000 && fixed.cachedInputTokens === 800 && fixed.outputTokens === 50 && fixed.reasoningTokens === 10],
    ["cost computed", fixed.costUsd > 0],
    ["diff measured", fixed.filesChanged.includes("src/session.js") && fixed.linesAdded === 1],
    ["tampering detected and undone", cheat.tamperedProtected.includes("test") && cheat.passed === false],
    ["key scrubbed from logs", !readFileSync(join(outDir, "logs", "selftest", "session-expiry-t1.requests.json"), "utf8").includes("sk-selftest-0000")],
  ];
  for (const [name, ok] of checks) log(`${ok ? "ok  " : "FAIL"} ${name}`);
  rmSync(outDir, { recursive: true, force: true });
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      harnesses: { type: "string" },
      tasks: { type: "string" },
      only: { type: "string" },
      trials: { type: "string", default: "3" },
      model: { type: "string", default: "deepseek-flash" },
      timeout: { type: "string" },
      out: { type: "string" },
      prices: { type: "string" },
      "max-cost": { type: "string" },
      upstream: { type: "string", default: "https://api.deepseek.com" },
      keep: { type: "boolean", default: false },
      "sandbox-sutra": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0] ?? "help";
  const allIds = Object.keys(ADAPTERS);
  const ids = values.harnesses ? values.harnesses.split(",").map((s) => s.trim()) : allIds;
  for (const id of ids) if (!ADAPTERS[id]) throw new Error(`Unknown harness "${id}". Known: ${allIds.join(", ")}`);

  if (cmd === "help" || values.help) {
    log(readFileSync(join(HERE, "README.md"), "utf8").split("## Options")[1]?.split("\n## ")[0] ?? "See README.md");
    return 0;
  }
  if (cmd === "check") {
    check(ids);
    return 0;
  }
  if (cmd === "selftest") return selftest();
  if (cmd !== "run") throw new Error(`Unknown command "${cmd}" (check | selftest | run)`);

  const found = findKey();
  if (!found) throw new Error("No DeepSeek key: set DEEPSEEK_API_KEY, or run `sutra init` so ~/.sutra/credentials.json has one.");
  const prices = values.prices ? JSON.parse(readFileSync(values.prices, "utf8")) : DEFAULT_PRICES;
  const tasks = loadTasks(values.tasks ? resolve(values.tasks) : join(ROOT, "benchmarks", "tasks"), values.only?.split(","));
  if (!tasks.length) throw new Error("No tasks found.");
  const trials = Math.max(1, Number(values.trials));
  const maxCost = values["max-cost"] ? Number(values["max-cost"]) : null;

  const status = check(ids);
  const runnable = ids.filter((id) => status[id]?.installed);
  const skipped = ids.filter((id) => !status[id]?.installed);
  if (!runnable.length) throw new Error("None of the selected harnesses is installed (see `./run.sh setup`).");
  const startedAt = new Date().toISOString();
  const outDir = resolve(values.out ?? join(HERE, "results", startedAt.replace(/[:.]/g, "-")));
  mkdirSync(outDir, { recursive: true });
  const total = runnable.length * tasks.length * trials;
  log(`\nKey from ${found.from === "DEEPSEEK_API_KEY" ? "$DEEPSEEK_API_KEY" : found.from} (not shown). ${runnable.length} harness(es) × ${tasks.length} task(s) × ${trials} trial(s) = ${total} runs, model ${values.model}.`);
  if (skipped.length) log(`Not installed, skipped: ${skipped.join(", ")}`);
  log("Every harness runs with all approvals granted, in a throwaway copy of each task, with an empty HOME. Results: " + outDir + "\n");

  const results = [];
  let spent = 0;
  let n = 0;
  // Interleave harnesses within each task and trial, so time-of-day effects (load, peak pricing) hit all of them alike.
  outer: for (let trial = 1; trial <= trials; trial++)
    for (const task of tasks)
      for (const id of runnable) {
        if (maxCost !== null && spent >= maxCost) {
          log(`Stopping: spent ${usd(spent)} of the --max-cost ${usd(maxCost)} budget.`);
          break outer;
        }
        n++;
        const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : (task.timeoutMs ?? 600_000);
        const r = await runOne({ harnessId: id, adapter: ADAPTERS[id], task, trial, model: values.model, key: found.key, prices, outDir, timeoutMs, upstream: values.upstream, keep: values.keep, sandboxSutra: values["sandbox-sutra"] });
        spent += r.costUsd;
        results.push(r);
        log(`[${String(n).padStart(3)}/${total}] ${r.passed ? "pass" : "FAIL"}  ${id.padEnd(12)} ${task.id.padEnd(16)} t${trial}  ${secs(r.wallMs).padStart(7)}  ${usd(r.costUsd).padStart(8)}  ${String(r.requests).padStart(3)} req${r.timedOut ? "  timeout" : ""}${r.tamperedProtected.length ? "  TAMPERED" : ""}${r.failedRequests ? `  ${r.failedRequests} failed req` : ""}`);
        writeFileSync(join(outDir, "results.partial.json"), JSON.stringify(results, null, 2));
      }

  const rows = aggregate(results, runnable, tasks);
  const meta = { schema: "sutra.harness-bench/v1", startedAt, finishedAt: new Date().toISOString(), model: values.model, upstream: values.upstream, trials, tasks: tasks.length, timeoutMs: values.timeout ? Number(values.timeout) * 1000 : (tasks[0].timeoutMs ?? 600_000), harnesses: Object.fromEntries(runnable.map((id) => [id, { name: ADAPTERS[id].name, version: status[id].version, missingFlags: status[id].missing, sources: ADAPTERS[id].sources }])), skipped };
  const report = { meta, rows, results, tasks: tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind })) };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), markdown(report));
  writeFileSync(join(outDir, "results.csv"), csv(results));
  rmSync(join(outDir, "results.partial.json"), { force: true });
  process.stdout.write("\n" + markdown(report));
  log(`\nSaved report.md, report.json, results.csv and per-run logs in ${outDir}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`error: ${err.message}`);
    process.exit(2);
  },
);
