import { homedir } from "node:os";
import { join } from "node:path";

/** Root for Sutra's user-level state. Override with SUTRA_HOME (used by tests). */
export function sutraHome(): string {
  return process.env.SUTRA_HOME ?? join(homedir(), ".sutra");
}

export const paths = {
  home: () => sutraHome(),
  userConfig: () => join(sutraHome(), "config.json"),
  credentials: () => join(sutraHome(), "credentials.json"),
  database: () => join(sutraHome(), "sutra.db"),
  logs: () => join(sutraHome(), "logs"),
  toolLogs: (sessionId: string) => join(sutraHome(), "logs", "tools", sessionId),
  exports: () => join(sutraHome(), "exports"),
  bench: () => join(sutraHome(), "bench"),
};
