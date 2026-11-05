import { basename } from "node:path";

/** File patterns that likely hold credentials. Matched against the relative path. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
  /(^|\/)\.sutra\/credentials\.json$/i,
];

const ENV_EXAMPLE = /\.env\.(example|sample|template)$/i;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export function matchesAny(relPath: string, globs: string[]): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return globs.some((g) => {
    const clean = g.replace(/^\.\//, "").replace(/\/$/, "");
    return globToRegExp(clean).test(norm) || norm === clean || norm.startsWith(clean + "/");
  });
}

export function isSensitivePath(relPath: string, extra: string[] = []): boolean {
  const norm = relPath.replace(/\\/g, "/");
  if (ENV_EXAMPLE.test(basename(norm))) return false;
  return SENSITIVE_PATTERNS.some((r) => r.test(norm)) || matchesAny(norm, extra);
}

/** Environment variable names that look like secrets. */
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i;
const SAFE_ENV = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PWD", "LOGNAME", "SSH_AUTH_SOCK"]);

/** Return a copy of env without secret-looking variables (for subprocesses). */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SAFE_ENV.has(k) || !SECRET_ENV.test(k)) out[k] = v;
  }
  return out;
}

/** Replace any known secret values in text sent to the model or UI. */
export class SecretRedactor {
  private secrets: string[] = [];
  add(secret: string | undefined): void {
    if (secret && secret.length >= 8 && !this.secrets.includes(secret)) this.secrets.push(secret);
  }
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted-secret]");
    // Common token shapes that should never be echoed back verbatim.
    out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[redacted-key]");
    out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
    return out;
  }
}
