import type { SutraConfig } from "../config/schema.js";
import type { RepoIndexService } from "../index/service.js";
import type { SessionStore } from "../memory/store.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { ModelProvider, TokenUsage } from "../providers/types.js";
import type { SandboxStatus } from "../sandbox/sandbox.js";
import type { UsageTotals } from "../telemetry/cost.js";
import { failureSignature, parseTestCounts, type TestCounts } from "../tools/shell/test-counts.js";
import type { ToolResult } from "../tools/types.js";
import { runProcess } from "../utils/process.js";
import { oneLine, truncateMiddle } from "../utils/text.js";
import { AuxModel } from "./aux.js";
import { runCandidates } from "./branches.js";
import type { HypothesisLedger } from "./ledger.js";
import { buildEvidencePacket } from "./localize.js";
import { isAuxiliary } from "../index/repo-index.js";
import { reviewAlignment } from "./review.js";
import { snapshotWorkspace, treeHash, type Snapshot } from "./snapshot.js";
import { LIMITS, type CandidateResult, type Check, type Counterexample, type Criterion, type QualityLimits, type QualityMode, type ReviewResult, type TaskKind, type Verification } from "./types.js";
import { findCounterexamples, rerunCounterexamples } from "./verifier.js";

export interface QualityEvent {
  type: "quality";
  stage: "packet" | "baseline" | "contract" | "stall" | "verify" | "review" | "gate" | "branch";
  message: string;
  level: "info" | "warn";
}

export interface QualityDeps {
  config: SutraConfig;
  provider: ModelProvider;
  model: () => string;
  workspaceRoot: string;
  repoIndex: RepoIndexService | null;
  permissions: PermissionEngine;
  sandbox: SandboxStatus;
  testCommand: string | null;
  store: SessionStore | null;
  ledger: HypothesisLedger;
  recordUsage: (model: string, usage: TokenUsage | null, latencyMs: number) => number | null;
  recordSubAgent: (totals: UsageTotals) => void;
  emit: (e: QualityEvent) => void;
}

export interface ObservedTool {
  name: string;
  category: string;
  readOnly: boolean;
  outcome: "ok" | "error" | "denied" | "cancelled";
  result: ToolResult;
}

export type FinishDecision = { action: "continue"; message: string } | { action: "finish"; verification: Verification | null };

const BUG_WORDS = /\b(fix|bug|broken|break|fail|failing|fails|error|crash|wrong|regression|incorrect|doesn'?t work|not working|throws?)\b/i;
const CHECK_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|ava|tap|cargo (test|check|build)|go (test|vet|build)|tsc|typecheck|lint|eslint|ruff|mypy|build|make)\b/;

/** Session-level owner of the quality mode; creates one TurnQuality per user turn. */
export class QualityEngine {
  mode: QualityMode;
  constructor(readonly d: QualityDeps) {
    this.mode = d.config.quality.mode;
  }

  startTurn(input: string, planOnly: boolean): TurnQuality {
    return new TurnQuality(this.d, this.mode, input, planOnly);
  }
}

export class TurnQuality {
  readonly limits: QualityLimits;
  readonly aux: AuxModel;
  private kind: TaskKind = "other";
  private criteria: { id: string; text: string; exec: boolean }[] = [];
  private checks: Check[] = [];
  private epoch = 0;
  private filesChanged = new Set<string>();
  private diffs: string[] = [];
  private bank: Counterexample[] = [];
  private cxRounds = 0;
  private bounces = 0;
  private review: ReviewResult | undefined;
  private reviewedTree: string | null = null;
  private candidates: CandidateResult[] = [];
  private branched = false;
  private initial: Snapshot | null = null;
  private notes: string[] = [];
  private lastFailSig: string | null = null;
  private editsSinceFail = 0;
  private editsPerFile = new Map<string, number>();
  private stallNoted = false;
  private packet: string | null = null;
  private auxCost = 0;

  constructor(
    private readonly d: QualityDeps,
    readonly mode: QualityMode,
    private readonly request: string,
    private readonly planOnly: boolean,
  ) {
    this.limits = LIMITS[mode];
    this.aux = new AuxModel({ provider: d.provider, model: d.model, recordUsage: d.recordUsage }, this.limits.maxAuxCostUsd);
  }

  // ------------------------------------------------------------ helpers

  /** Commands an unattended harness step may run: inside the OS sandbox, or ones the user's policy auto-allows. */
  private canRunUnattended(command: string): boolean {
    if (this.d.sandbox.runner) return true;
    return this.d.permissions.evaluate({ tool: "run_tests", category: "execute", command, paths: [], summary: command }).verdict === "allow";
  }

  /** Sub-agents run commands without anyone to approve them: require the sandbox or the user's Flow profile. */
  private subAgentsAllowed(): { ok: boolean; why?: string } {
    if (this.d.sandbox.runner || this.d.permissions.policy.profile === "flow") return { ok: true };
    return { ok: false, why: "needs the OS sandbox or the flow profile, because sub-agents run commands with nobody to approve them" };
  }

  private addCheck(c: Omit<Check, "id" | "at" | "epoch">): Check {
    const check: Check = { ...c, id: `c${this.checks.length + 1}`, epoch: this.epoch, at: new Date().toISOString() };
    this.checks.push(check);
    return check;
  }

  private fresh(c: Check): boolean {
    return c.epoch === this.epoch;
  }

  private spendSubAgent(t: UsageTotals | null): void {
    if (!t) return;
    this.auxCost += t.costUsd;
    this.aux.spent += t.costUsd;
    this.d.recordSubAgent(t);
  }

  // -------------------------------------------------------------- begin

  /** Before the first inference: contract, baseline, evidence packet. Returns text appended to the request. */
  async begin(signal?: AbortSignal): Promise<string | null> {
    this.kind = BUG_WORDS.test(this.request) ? "bugfix" : "other";
    if (this.limits.contract && !this.planOnly) await this.extractContract(signal);

    let baselineNote: string | undefined;
    if (this.limits.packet && !this.planOnly && this.kind === "bugfix" && this.d.testCommand) {
      if (this.canRunUnattended(this.d.testCommand)) {
        const argv = this.d.sandbox.runner ? this.d.sandbox.runner.wrap(this.d.testCommand, this.d.workspaceRoot, false) : undefined;
        const r = await runProcess({ command: this.d.testCommand, ...(argv ? { argv } : {}), cwd: this.d.workspaceRoot, timeoutMs: Math.min(this.d.config.tools.commandTimeoutMs, 180_000), ...(signal ? { signal } : {}), env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
        const out = r.stdout + "\n" + r.stderr;
        const counts = parseTestCounts(out);
        const failing = failureSignature(out)?.split("|").filter((x) => !x.startsWith("failed:")) ?? [];
        const b = this.addCheck({ kind: "baseline", summary: `${this.d.testCommand} before any edit`, command: this.d.testCommand, exitCode: r.exitCode, ...(counts ? { counts } : {}), ...(failing.length ? { failing } : {}), passed: r.exitCode === 0 });
        this.d.emit({ type: "quality", stage: "baseline", level: "info", message: `baseline \`${this.d.testCommand}\` → exit ${r.exitCode}${counts ? ` (${counts.failed} of ${counts.total} failing)` : ""}` });
        void b;
      } else baselineNote = `not run automatically (running \`${this.d.testCommand}\` needs your approval in this profile); run_tests will establish it`;
    }

    if (this.limits.candidates > 0 && !this.planOnly) {
      try {
        this.initial = snapshotWorkspace(this.d.workspaceRoot);
      } catch (err) {
        this.d.emit({ type: "quality", stage: "branch", level: "warn", message: `no initial snapshot (${(err as Error).message}); competing patches disabled for this turn` });
      }
    }

    if (!this.limits.packet || !this.d.repoIndex) return null;
    this.d.repoIndex.refresh();
    const baseline = this.checks.find((c) => c.kind === "baseline") ?? null;
    const packet = buildEvidencePacket({ request: this.request, index: this.d.repoIndex.index, baseline, ...(baselineNote ? { baselineNote } : {}) });
    if (!packet) return null;
    this.packet = packet.text;
    const contract = this.criteria.length ? `\nAcceptance criteria the harness will check at the end:\n${this.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}` : "";
    this.d.emit({ type: "quality", stage: "packet", level: "info", message: `evidence packet: ${packet.files.length} likely location(s)${baseline ? ", baseline recorded" : ""}${this.criteria.length ? `, ${this.criteria.length} acceptance criteria` : ""}` });
    return packet.text + contract;
  }

  private async extractContract(signal?: AbortSignal): Promise<void> {
    const r = await this.aux.json<{ kind?: string; criteria?: { text?: string; needs_execution?: boolean }[] }>(
      "Turn a coding request into a task contract: what kind of task it is and 1-5 concrete acceptance criteria that could be checked. Only include what the user actually asked for or clearly implied. Mark needs_execution true when a criterion can only be confirmed by running code or tests.",
      `Request:\n${this.request}\n\nJSON: {"kind": "bugfix" | "feature" | "refactor" | "question" | "other", "criteria": [{"text": "...", "needs_execution": true}]}`,
      { maxTokens: 500, ...(signal ? { signal } : {}) },
    );
    if (!r) return;
    if (r.kind === "bugfix" || r.kind === "feature" || r.kind === "refactor" || r.kind === "question" || r.kind === "other") this.kind = r.kind;
    this.criteria = (r.criteria ?? [])
      .filter((c) => typeof c.text === "string" && c.text.trim())
      .slice(0, 5)
      .map((c, i) => ({ id: `C${i + 1}`, text: oneLine(c.text!, 200), exec: c.needs_execution !== false }));
    if (this.criteria.length) this.d.emit({ type: "quality", stage: "contract", level: "info", message: `${this.kind}: ${this.criteria.map((c) => c.text).join(" · ")}` });
  }

  // ------------------------------------------------------------ observe

  observe(t: ObservedTool): void {
    const r = t.result;
    const data = r.data ?? {};
    if (t.outcome === "ok" && r.ok && Array.isArray(data.files) && !t.readOnly && t.category === "write") {
      this.epoch++;
      this.editsSinceFail++;
      for (const f of data.files as string[]) {
        this.filesChanged.add(f);
        this.editsPerFile.set(f, (this.editsPerFile.get(f) ?? 0) + 1);
      }
      if (typeof data.diff === "string") this.diffs.push(data.diff);
      return;
    }
    if (t.category === "execute" && "exitCode" in data && "command" in data) {
      const command = String(data.command);
      const isTest = t.name === "run_tests" || CHECK_COMMAND.test(command);
      const exitCode = (data.exitCode as number | null) ?? null;
      const counts = data.counts as TestCounts | undefined;
      const failing = data.failing as string[] | undefined;
      this.addCheck({
        kind: isTest ? "test" : "command",
        summary: `${command} → exit ${exitCode}${counts ? ` (${counts.passed}/${counts.total} passed)` : ""}`,
        command,
        exitCode,
        ...(counts ? { counts } : {}),
        ...(failing ? { failing } : {}),
        passed: exitCode === 0,
      });
      // A command can change files too: later file checks are no longer "after the last edit".
      if (!isTest) this.epoch++;
      if (isTest) this.watchForStall(r.output, exitCode === 0);
    }
  }

  private watchForStall(output: string, passed: boolean): void {
    if (passed) {
      this.lastFailSig = null;
      this.editsSinceFail = 0;
      return;
    }
    const sig = failureSignature(output);
    const repeatedFile = [...this.editsPerFile.entries()].find(([, n]) => n >= 3);
    if (sig && sig === this.lastFailSig && this.editsSinceFail > 0 && !this.stallNoted) {
      this.stallNoted = true;
      this.notes.push(
        `[Sutra: the same tests are still failing after your last edit (${oneLine(sig.replace(/\|/g, ", "), 160)}). Before editing again, write down two or three competing explanations with the hypotheses tool and run the cheapest check that tells them apart (a single assertion, a log line, a minimal input).]`,
      );
      this.d.emit({ type: "quality", stage: "stall", level: "warn", message: "same failing tests after an edit — asked for competing hypotheses and a distinguishing check" });
    } else if (repeatedFile && !this.stallNoted) {
      this.stallNoted = true;
      this.notes.push(`[Sutra: ${repeatedFile[0]} has been edited ${repeatedFile[1]} times and tests still fail. Step back: record competing explanations with the hypotheses tool and test the cheapest one first.]`);
      this.d.emit({ type: "quality", stage: "stall", level: "warn", message: `${repeatedFile[0]} edited ${repeatedFile[1]}× with tests still failing — asked for hypotheses` });
    }
    this.lastFailSig = sig;
    this.editsSinceFail = 0;
  }

  takeNotes(): string[] {
    const n = this.notes;
    this.notes = [];
    return n;
  }

  // ------------------------------------------------------------- finish

  /** The model stopped calling tools. Decide whether the evidence supports finishing. */
  async finish(finalText: string, signal?: AbortSignal): Promise<FinishDecision> {
    if (this.planOnly) return { action: "finish", verification: null };
    const changed = this.filesChanged.size > 0;
    const hasChecks = this.checks.some((c) => c.kind !== "baseline");
    if (!changed && !hasChecks && (this.kind === "question" || this.kind === "other") && this.criteria.every((c) => !c.exec)) {
      this.dispose();
      return { action: "finish", verification: null };
    }

    // 0. What changed, from the harness's own record (no model needed to know this).
    if (changed) {
      const files = [...this.filesChanged];
      const tests = files.filter((f) => isAuxiliary(f) || /(^|\/)(test|spec)s?\//i.test(f) || /\.(test|spec)\./i.test(f));
      const prev = [...this.checks].reverse().find((c) => c.kind === "diff");
      if (!prev || !this.fresh(prev))
        this.addCheck({ kind: "diff", summary: `harness record: changed ${files.join(", ")}; ${tests.length ? `test files changed: ${tests.join(", ")}` : "no test files changed"}`, passed: tests.length === 0 });
    }

    // 1. Independent alignment review of the current patch.
    const tree = changed ? treeHash(this.d.workspaceRoot, [...this.filesChanged]) : null;
    if (changed && this.limits.review && tree !== this.reviewedTree && !this.aux.exhausted) {
      this.d.emit({ type: "quality", stage: "review", level: "info", message: "independent review: inferring what the patch does without the request" });
      this.review = await reviewAlignment(this.aux, { request: this.request, diff: this.diffs.join("\n"), checks: this.checks.map((c) => `- ${c.summary}`).join("\n"), ...(signal ? { signal } : {}) });
      this.reviewedTree = tree;
      this.addCheck({ kind: "review", summary: `review: ${this.review.verdict}${this.review.gaps.length ? ` — ${this.review.gaps.join("; ")}` : ""}`, passed: this.review.verdict === "aligned" });
      this.d.emit({ type: "quality", stage: "review", level: this.review.verdict === "aligned" ? "info" : "warn", message: `review: ${this.review.verdict}${this.review.inferred ? ` — "${oneLine(this.review.inferred, 120)}"` : ""}` });
    }

    // 2. Judge each criterion against fresh evidence.
    let criteria = await this.judge(finalText, signal);

    // 3. Counterexamples. Balanced hunts only when a criterion still lacks evidence
    //    (a well-covered fix stays cheap); deep always hunts. Banked ones are re-checked.
    const wantHunt = this.mode === "deep" || criteria.some((c) => c.status !== "passed");
    if (changed && this.d.testCommand) {
      const allowed = this.subAgentsAllowed();
      if (wantHunt && this.cxRounds < this.limits.counterexampleRounds && !this.aux.exhausted && allowed.ok) {
        this.cxRounds++;
        this.d.emit({ type: "quality", stage: "verify", level: "info", message: "verifier: searching for counterexamples in an isolated copy" });
        try {
          const res = await findCounterexamples(
            { config: this.d.config, provider: this.d.provider, model: this.d.model(), store: this.d.store, sandbox: this.d.sandbox.runner },
            { workspaceRoot: this.d.workspaceRoot, request: this.request, diff: this.diffs.join("\n"), maxCostUsd: Math.max(0.01, (this.limits.maxAuxCostUsd - this.aux.spent) / 2), ...(signal ? { signal } : {}) },
          );
          this.spendSubAgent(res.totals);
          for (const c of res.found) if (!this.bank.some((b) => b.file === c.file && b.content === c.content)) this.bank.push(c);
          this.d.emit({ type: "quality", stage: "verify", level: res.found.length ? "warn" : "info", message: `verifier: ${res.found.length} confirmed counterexample(s)${res.note ? `; ${res.note}` : ""}` });
        } catch (err) {
          if (signal?.aborted) throw err;
          this.d.emit({ type: "quality", stage: "verify", level: "warn", message: `verifier failed: ${(err as Error).message}` });
        }
      } else if (this.bank.length) {
        this.bank = await rerunCounterexamples(this.bank, this.d.workspaceRoot, this.d.sandbox.runner, signal);
      } else if (!allowed.ok && this.limits.counterexampleRounds > 0 && this.cxRounds === 0) {
        this.cxRounds = this.limits.counterexampleRounds;
        this.d.emit({ type: "quality", stage: "verify", level: "info", message: `counterexample search skipped: ${allowed.why}` });
      }
      const failingCx = this.bank.filter((c) => c.failing);
      const hadCx = this.checks.some((c) => c.kind === "counterexample" && this.fresh(c));
      for (const c of failingCx) this.addCheck({ kind: "counterexample", summary: `provisional test "${c.name}" fails`, command: c.command, passed: false, provisional: true });
      for (const c of this.bank.filter((c) => !c.failing)) this.addCheck({ kind: "counterexample", summary: `provisional test "${c.name}" passes`, command: c.command, passed: true, provisional: true });
      if (failingCx.length && this.bounces < this.limits.bounces) {
        this.bounces++;
        return { action: "continue", message: this.counterexampleMessage(failingCx) };
      }
      // New probe results can change the verdict: judge again with them.
      if (this.bank.length && !hadCx) criteria = await this.judge(finalText, signal);
    }
    const gaps = criteria.filter((c) => c.status !== "passed");

    // 4. Competing patches (deep) when the fix still fails.
    const lastTest = [...this.checks].reverse().find((c) => c.kind === "test");
    const failing = (lastTest && this.fresh(lastTest) && !lastTest.passed) || this.bank.some((c) => c.failing);
    if (this.limits.candidates > 0 && this.initial && !this.branched && failing && this.d.testCommand && this.bounces >= this.limits.bounces) {
      this.branched = true;
      const allowed = this.subAgentsAllowed();
      if (!allowed.ok) this.d.emit({ type: "quality", stage: "branch", level: "info", message: `competing patches skipped: ${allowed.why}` });
      else if (!this.aux.exhausted) {
        this.d.emit({ type: "quality", stage: "branch", level: "info", message: `first fix still fails — trying ${this.limits.candidates} competing patches from the initial snapshot` });
        const outcome = await runCandidates(
          { config: this.d.config, provider: this.d.provider, model: this.d.model(), store: this.d.store, sandbox: this.d.sandbox.runner, aux: this.aux },
          {
            initial: this.initial,
            workspaceRoot: this.d.workspaceRoot,
            request: this.request,
            packet: this.packet,
            lessons: this.lessons(finalText),
            hypotheses: this.d.ledger.list(),
            count: this.limits.candidates,
            verifyCommand: this.d.testCommand,
            bank: this.bank,
            mainChanged: [...this.filesChanged],
            maxCostUsd: Math.max(0.02, this.limits.maxAuxCostUsd - this.aux.spent),
            ...(signal ? { signal } : {}),
          },
        );
        for (const t of outcome.totals) this.spendSubAgent(t);
        this.candidates = outcome.results;
        this.d.emit({ type: "quality", stage: "branch", level: outcome.selected ? "info" : "warn", message: outcome.results.map((r) => `${r.label}: ${r.reason}`).join(" · ") || "no candidates produced" });
        if (outcome.selected && outcome.patch) return { action: "continue", message: this.applyCandidateMessage(outcome.selected, outcome.patch, outcome.results) };
      }
    }

    // 5. Bounce once more if criteria lack evidence and the mode allows it.
    if (gaps.length && this.bounces < this.limits.bounces) {
      this.bounces++;
      return { action: "continue", message: this.gateMessage(gaps) };
    }

    const v = this.verification(criteria);
    this.dispose();
    return { action: "finish", verification: v };
  }

  /** Deterministic record for turns that end another way (budget, failure, cancel). */
  partial(): Verification | null {
    if (this.planOnly || (!this.filesChanged.size && !this.checks.length)) {
      this.dispose();
      return null;
    }
    const v = this.verification(this.deterministicCriteria());
    this.dispose();
    return v;
  }

  dispose(): void {
    this.initial?.cleanup();
    this.initial = null;
  }

  // -------------------------------------------------------------- judge

  private defaultCriteria(): { id: string; text: string; exec: boolean }[] {
    const out: { id: string; text: string; exec: boolean }[] = [];
    if (this.filesChanged.size) out.push({ id: "C1", text: "The requested change is implemented", exec: true });
    if (this.d.testCommand && this.filesChanged.size) out.push({ id: `C${out.length + 1}`, text: "The test suite passes after the final edit", exec: true });
    return out;
  }

  private deterministicCriteria(): Criterion[] {
    const crit = this.criteria.length ? this.criteria : this.defaultCriteria();
    const freshTests = this.checks.filter((c) => (c.kind === "test" || c.kind === "counterexample") && this.fresh(c));
    const failingFresh = freshTests.filter((c) => !c.passed && !c.provisional);
    const passingFresh = freshTests.filter((c) => c.passed && !c.provisional);
    const diff = [...this.checks].reverse().find((c) => c.kind === "diff" && this.fresh(c));
    return crit.map((c) => {
      if (diff && /test/i.test(c.text) && /(modif|chang|edit|untouched|unmodified|weaken)/i.test(c.text))
        return { id: c.id, text: c.text, status: diff.passed ? "passed" : "failed", evidence: [diff.id] };
      if (/test|suite|pass/i.test(c.text)) {
        if (failingFresh.length) return { id: c.id, text: c.text, status: "failed", evidence: failingFresh.map((x) => x.id), note: `${failingFresh[0]!.summary}` };
        if (passingFresh.length) return { id: c.id, text: c.text, status: "passed", evidence: [passingFresh[passingFresh.length - 1]!.id] };
      }
      const why = this.filesChanged.size && !freshTests.length ? "no check ran after the last edit" : this.mode === "fast" ? "not mapped to a check in fast mode" : "no check maps to it";
      return { id: c.id, text: c.text, status: "unverified", evidence: [], note: why };
    });
  }

  private async judge(finalText: string, signal?: AbortSignal): Promise<Criterion[]> {
    const crit = this.criteria.length ? this.criteria : this.defaultCriteria();
    if (!crit.length) return [];
    if (this.mode === "fast" || this.aux.exhausted) return this.deterministicCriteria();
    const checkList = this.checks
      .map((c) => `${c.id} [${c.kind}${c.provisional ? ", provisional" : ""}${this.fresh(c) ? ", after last edit" : ", BEFORE last edit (stale)"}] ${c.passed ? "PASSED" : "FAILED"}: ${c.summary}${c.failing?.length ? ` — failing: ${c.failing.slice(0, 5).join("; ")}` : ""}`)
      .join("\n");
    const r = await this.aux.json<{ criteria?: { id?: string; status?: string; evidence?: string[]; note?: string }[] }>(
      "You are a strict verification judge for a coding agent. For each acceptance criterion, decide passed / failed / unverified using ONLY the listed checks, and cite their ids. Rules: (1) only checks that ran after the last edit count; (2) a project test run that passes after the last edit is valid evidence for the behaviour those tests exercise, including the change the task asked for when the tests target it; (3) the harness record (kind diff) is authoritative about which files changed, including whether any test files were modified; (4) a review check alone never passes a criterion; (5) provisional checks were generated by a verifier and may be wrong; (6) the agent's own final message is a claim, not evidence. If nothing listed demonstrates a criterion, it is unverified.",
      `Criteria:\n${crit.map((c) => `${c.id}: ${c.text}${c.exec ? " (needs execution)" : ""}`).join("\n")}\n\nFiles changed: ${[...this.filesChanged].join(", ") || "none"}\n\nChecks:\n${checkList || "(none)"}\n\nAgent's final message (claim only):\n${truncateMiddle(finalText, 1500).text}\n\nJSON: {"criteria": [{"id": "C1", "status": "passed" | "failed" | "unverified", "evidence": ["c3"], "note": "short reason"}]}`,
      { maxTokens: 700, ...(signal ? { signal } : {}) },
    );
    if (!r?.criteria) return this.deterministicCriteria();
    const byId = new Map(this.checks.map((c) => [c.id, c]));
    return crit.map((c) => {
      const j = r.criteria!.find((x) => x.id === c.id);
      const evidence = (j?.evidence ?? []).filter((id) => byId.has(id));
      let status: Criterion["status"] = j?.status === "passed" || j?.status === "failed" ? j.status : "unverified";
      let note = j?.note ? oneLine(j.note, 200) : undefined;
      // The harness, not the judge, enforces what counts as evidence.
      if (status === "passed") {
        const support = evidence.map((id) => byId.get(id)!).filter((x) => x.passed && x.kind !== "review" && x.kind !== "baseline" && this.fresh(x));
        // (diff checks are harness facts recorded at finish, so they are always fresh)
        if (!support.length && (c.exec || evidence.length)) {
          status = "unverified";
          note = "no passing check after the last edit supports it";
        } else if (support.length && support.every((s) => s.provisional)) note = `${note ? note + "; " : ""}supported only by provisional tests`;
      }
      if (status === "failed" && !evidence.length) {
        status = "unverified";
        note = note ?? "judge cited no failing check";
      }
      return { id: c.id, text: c.text, status, evidence, ...(note ? { note } : {}) };
    });
  }

  private verification(criteria: Criterion[]): Verification {
    const passed = criteria.filter((c) => c.status === "passed").length;
    const overall: Verification["overall"] = criteria.some((c) => c.status === "failed")
      ? "failed"
      : criteria.length && passed === criteria.length
        ? "verified"
        : passed
          ? "partial"
          : "unverified";
    return {
      mode: this.mode,
      kind: this.kind,
      overall,
      criteria,
      checks: this.checks,
      filesChanged: [...this.filesChanged],
      treeHash: this.filesChanged.size ? treeHash(this.d.workspaceRoot, [...this.filesChanged]) : null,
      ...(this.review ? { review: this.review } : {}),
      counterexamples: this.bank.map(({ content: _c, ...rest }) => ({ ...rest, content: "" })),
      candidates: this.candidates,
      hypotheses: this.d.ledger.list(),
      bounces: this.bounces,
      auxCostUsd: this.aux.spent,
    };
  }

  // ------------------------------------------------------------ messages

  private lessons(finalText: string): string {
    const tests = this.checks.filter((c) => c.kind === "test").slice(-3);
    return [
      `Files it changed: ${[...this.filesChanged].join(", ") || "none"}`,
      `Its diff:\n${truncateMiddle(this.diffs.join("\n"), 4000).text}`,
      `Test results: ${tests.map((t) => `${t.summary}${t.failing?.length ? ` (failing: ${t.failing.slice(0, 4).join("; ")})` : ""}`).join(" | ") || "none"}`,
      this.bank.some((c) => c.failing) ? `Counterexamples still failing: ${this.bank.filter((c) => c.failing).map((c) => `${c.name} — ${c.why}`).join("; ")}` : "",
      this.d.ledger.list().length ? `Hypotheses:\n${this.d.ledger.render()}` : "",
      `Its final message: ${oneLine(finalText, 400)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private counterexampleMessage(cx: Counterexample[]): string {
    const items = cx
      .map((c) => `- "${c.name}" — ${c.why}\n  Run with: \`${c.command}\`\n\`\`\`\n${truncateMiddle(c.content, 1800).text}\n\`\`\``)
      .join("\n");
    return `[Sutra verifier] An independent verifier wrote provisional tests that FAIL on your current patch (Sutra re-ran each one to confirm). They are generated, not authoritative: first decide whether each reflects what the user asked for. If it does, fix the code; if it doesn't, say why in your final answer. These files are not in the workspace; do not add them unless the user wants new tests.\n${items}`;
  }

  private gateMessage(gaps: Criterion[]): string {
    const byId = new Map(this.checks.map((c) => [c.id, c]));
    const lines = gaps.map((g) => {
      const ev = g.evidence.map((id) => byId.get(id)).filter(Boolean).map((c) => `${c!.id} ${c!.summary}${c!.failing?.length ? `; failing: ${c!.failing.slice(0, 4).map((f) => `"${f}"`).join(", ")}` : ""}`);
      return `- ${g.id} "${g.text}" — ${g.status}${g.note ? `: ${g.note}` : ""}${ev.length ? ` [${ev.join(" | ")}]` : ""}`;
    });
    const review = this.review && this.review.verdict !== "aligned" ? `\nIndependent review (supplementary): ${this.review.verdict} — the reviewer thinks the patch "${oneLine(this.review.inferred, 200)}"${this.review.gaps.length ? `; gaps: ${this.review.gaps.join("; ")}` : ""}` : "";
    return `[Sutra finish gate] Before this can be reported as done, these acceptance criteria need evidence from a check run after your last edit:\n${lines.join("\n")}${review}\nAddress them (fix the code, or run the check that would show it). If a criterion genuinely cannot be verified here, say exactly why in your final answer instead of claiming it.`;
  }

  private applyCandidateMessage(sel: CandidateResult, patch: string, all: CandidateResult[]): string {
    const others = all.filter((r) => r !== sel).map((r) => `${r.label}: ${r.reason}`).join("; ");
    return `[Sutra competing patches] Your fix did not pass verification, so ${all.length} independent candidates were tried from the original state of the workspace, each pursuing a different explanation. Candidate ${sel.label} ("${oneLine(sel.hypothesis, 160)}") passes \`${this.d.testCommand}\` without modifying any test${this.bank.length ? " and fixes the provisional counterexamples" : ""} (${sel.diffLines} changed lines).${others ? ` Others: ${others}.` : ""}\nReplace your changes with this patch: apply it exactly with apply_patch (it also reverts your earlier edits where needed), run the tests, then finish and explain the cause.\n\`\`\`diff\n${patch}\n\`\`\``;
  }
}
