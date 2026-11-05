/**
 * Heuristic shell command classification.
 *
 * This is an approval aid, NOT a sandbox. Any command can run arbitrary code
 * (a "test" script can delete files), so only the narrow `routine` class is
 * ever auto-approved, and only in the `flow` profile.
 */
export type CommandRisk = "routine" | "unknown" | "network" | "destructive" | "privileged";

export interface CommandAssessment {
  risk: CommandRisk;
  reasons: string[];
  compound: boolean;
  /** Some segment needs the network (independent of the overall risk). */
  network: boolean;
}

const PRIVILEGED = /^(sudo|su|doas|pkexec)$/;

const DESTRUCTIVE_RULES: [RegExp, string][] = [
  [/^(rm|rmdir|shred|unlink|srm)\b/, "deletes files"],
  [/^(dd|mkfs(\.\w+)?|fdisk|diskutil|parted|wipefs)\b/, "low-level disk operation"],
  [/^truncate\b/, "truncates files"],
  [/^(chmod|chown|chgrp)\b.*\s-R\b/, "recursive permission change"],
  [/^(kill|killall|pkill)\b/, "terminates processes"],
  [/^git\s+(reset\s+--hard|clean\b|checkout\s+--|checkout\s+\.|restore\b|stash\s+(drop|clear)|branch\s+-D|push\b|rebase\b|filter-branch|filter-repo|reflog\s+expire|gc\s+--prune|update-ref\s+-d)/, "rewrites or discards git history/changes"],
  [/^git\s+commit\b.*--amend/, "rewrites the last commit"],
  [/^find\b.*\s-(delete|exec|execdir|ok)\b/, "find with delete/exec"],
  [/^xargs\b/, "executes commands from input"],
  [/^(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate)\b/, "publishes packages"],
  [/^(cargo|gem|twine)\s+(publish|push|yank|upload)\b/, "publishes packages"],
  [/^docker\s+(rm|rmi|system\s+prune|volume\s+rm|image\s+prune|container\s+prune)\b/, "removes docker resources"],
  [/^kubectl\s+(delete|apply|replace|drain)\b/, "changes a cluster"],
  [/^terraform\s+(apply|destroy|import)\b/, "changes infrastructure"],
  [/^(shutdown|reboot|halt|launchctl|systemctl)\b/, "system service control"],
  [/^(crontab)\b/, "changes scheduled jobs"],
  [/^mv\b/, "moves/overwrites files"],
  [/^(eval|exec|source|\.)\s/, "executes dynamic code"],
];

const NETWORK_RULES: [RegExp, string][] = [
  [/^(curl|wget|http|https|aria2c|nc|ncat|netcat|telnet|ftp|sftp|ssh|scp|rsync|socat)\b/, "network access"],
  [/^git\s+(push|pull|fetch|clone|remote\s+(add|set-url)|submodule\s+update|ls-remote)\b/, "contacts a git remote"],
  [/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|dlx|create|init)\b/, "downloads packages"],
  [/^npx\s+(--yes|-y)\b/, "downloads and runs a package"],
  [/^(pip|pip3|uv|poetry|pipx)\s+(install|add|sync|download)\b/, "downloads packages"],
  [/^(cargo)\s+(install|add|update|fetch)\b/, "downloads packages"],
  [/^go\s+(get|install|mod\s+download)\b/, "downloads packages"],
  [/^(brew|apt|apt-get|yum|dnf|pacman|apk|port)\b/, "system package manager"],
  [/^(gh|glab|hub)\b/, "talks to a code host"],
  [/^docker\s+(pull|push|login|run|build)\b/, "docker network/registry"],
];

/** Read-only or standard verification commands. */
const ROUTINE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|echo|printf|grep|egrep|rg|ag|tree|file|stat|du|df|date|uname|which|whoami|basename|dirname|realpath|sort|uniq|cut|tr|diff|cmp|true|false|test)\b/,
  /^find\b/,
  /^git\s+(status|diff|log|show|branch(\s+(-a|-r|--list|-v|-vv))?\s*$|rev-parse|ls-files|blame|describe|shortlog|tag\s*$|tag\s+-l)\b/,
  /^(node|npm|pnpm|yarn|python|python3|cargo|go|rustc|tsc|deno|bun)\s+(--version|-v|-V|version)\s*$/,
  /^(npm|pnpm|yarn|bun)\s+(test|t)\b/,
  /^(npm|pnpm|yarn|bun)\s+run\s+(test|build|lint|typecheck|check|format:check|type-check)\b/,
  /^npx\s+(tsc|vitest|jest|eslint|prettier\s+--check|mocha|playwright\s+test)\b/,
  /^(tsc|vitest|jest|eslint|mocha)\b/,
  /^(pytest|python3?\s+-m\s+(pytest|unittest|mypy|ruff|compileall))\b/,
  /^(ruff|mypy|flake8|black\s+--check)\b/,
  /^cargo\s+(test|build|check|clippy|fmt\s+--check)\b/,
  /^go\s+(test|build|vet)\b/,
  /^make\s+(test|check|build|lint)\s*$/,
  /^node\s+--test\b/,
];

/** Split on control operators; also reports substitutions and redirections. */
export function splitCommand(cmd: string): { segments: string[]; substitution: boolean; redirect: boolean; background: boolean } {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let substitution = false;
  let redirect = false;
  let background = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    const next = cmd[i + 1];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        current += ch + (next ?? "");
        i++;
        continue;
      }
      if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) substitution = true;
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) substitution = true;
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (ch === "&" && next !== "&") {
        // "2>&1" style fd duplication is not a separator
        if (current.endsWith(">")) {
          current += ch;
          continue;
        }
        background = true;
      }
      segments.push(current.trim());
      current = "";
      if ((ch === "|" || ch === "&") && next === ch) i++;
      continue;
    }
    if (ch === ">" || ch === "<") {
      const isFdDup = ch === ">" && next === "&";
      const isDevNull = cmd.slice(i).match(/^>+\s*\/dev\/null/);
      if (!isFdDup && !isDevNull) redirect = true;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return { segments: segments.filter(Boolean), substitution, redirect, background };
}

function stripEnvAssignments(seg: string): string {
  return seg.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, "").trim();
}

export function assessCommand(command: string, extraRoutinePrefixes: string[] = []): CommandAssessment {
  const reasons: string[] = [];
  const { segments, substitution, redirect, background } = splitCommand(command);
  const compound = segments.length > 1 || substitution || redirect || background;
  let worst: CommandRisk = "routine";
  let needsNetwork = false;
  const rank: Record<CommandRisk, number> = { routine: 0, unknown: 1, network: 2, destructive: 3, privileged: 4 };
  const bump = (r: CommandRisk, why?: string) => {
    if (why && !reasons.includes(why)) reasons.push(why);
    if (rank[r] > rank[worst]) worst = r;
  };

  if (substitution) bump("unknown", "uses command substitution");
  if (redirect) bump("unknown", "redirects output to a file");
  if (background) bump("unknown", "starts a background job");
  if (/\|\s*(sh|bash|zsh|fish|python3?|node|perl|ruby)\b/.test(command)) bump("destructive", "pipes data into an interpreter");

  for (const raw of segments) {
    const seg = stripEnvAssignments(raw);
    const first = seg.split(/\s+/)[0] ?? "";
    if (PRIVILEGED.test(first)) {
      bump("privileged", "runs with elevated privileges");
      continue;
    }
    const destructive = DESTRUCTIVE_RULES.find(([r]) => r.test(seg));
    if (destructive) bump("destructive", destructive[1]);
    const network = NETWORK_RULES.find(([r]) => r.test(seg));
    if (network) {
      bump("network", network[1]);
      needsNetwork = true;
    }
    if (destructive || network) continue;
    const routine = ROUTINE.some((r) => r.test(seg)) || extraRoutinePrefixes.some((p) => p && (seg === p || seg.startsWith(p + " ")));
    if (!routine) bump("unknown");
  }
  if (segments.length === 0) bump("unknown", "empty command");
  return { risk: worst, reasons, compound, network: needsNetwork };
}
