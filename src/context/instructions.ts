import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sutraHome } from "../config/paths.js";

export interface InstructionSource {
  /** Display path. */
  path: string;
  scope: "user" | "repository" | "repository-sutra";
  content: string;
  truncated: boolean;
}

const MAX_BYTES = 32 * 1024;

function read(path: string, display: string, scope: InstructionSource["scope"]): InstructionSource | null {
  if (!existsSync(path)) return null;
  try {
    if (!statSync(path).isFile()) return null;
    const raw = readFileSync(path, "utf8");
    const truncated = raw.length > MAX_BYTES;
    return { path: display, scope, content: truncated ? raw.slice(0, MAX_BYTES) : raw, truncated };
  } catch {
    return null;
  }
}

/**
 * Instruction precedence (later entries refine earlier ones for conventions):
 *   1. ~/.sutra/AGENTS.md        — the user's own global preferences
 *   2. <repo>/AGENTS.md          — conventional repository instructions
 *   3. <repo>/.sutra/AGENTS.md   — Sutra-specific repository instructions
 *
 * None of these can change Sutra's permission policy; they are injected into
 * the prompt as guidance only, below the harness's own system rules.
 */
export function loadInstructions(workspaceRoot: string): InstructionSource[] {
  return [
    read(join(sutraHome(), "AGENTS.md"), "~/.sutra/AGENTS.md", "user"),
    read(join(workspaceRoot, "AGENTS.md"), "AGENTS.md", "repository"),
    read(join(workspaceRoot, ".sutra", "AGENTS.md"), ".sutra/AGENTS.md", "repository-sutra"),
  ].filter((x): x is InstructionSource => x !== null);
}

export const AGENTS_TEMPLATE = `# Project instructions for Sutra

<!-- Sutra reads this file at the start of every session. Keep it short and concrete. -->

## Commands
- Test: \`npm test\`
- Type check: \`npm run typecheck\`

## Conventions
- (coding style, naming, error-handling rules)

## Architecture constraints
- (layers, modules that must not depend on each other)

## Restricted areas
- (directories the agent should not modify, e.g. generated code)
`;
