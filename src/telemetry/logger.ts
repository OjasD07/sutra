import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { paths } from "../config/paths.js";

let logger: Logger = pino({ level: "silent" });

/**
 * Structured debug log written to ~/.sutra/logs/sutra.log (never to the
 * terminal, which belongs to the UI). Reasoning content and credentials are
 * never passed to the logger; the redact list is a second line of defence.
 */
export function initLogger(opts: { debug: boolean }): Logger {
  const dir = paths.logs();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  logger = pino(
    {
      level: opts.debug ? "debug" : "info",
      redact: {
        paths: ["apiKey", "*.apiKey", "headers.authorization", "*.reasoning", "reasoning", "*.reasoning_content"],
        censor: "[redacted]",
      },
      base: { pid: process.pid },
    },
    pino.destination({ dest: join(dir, "sutra.log"), mkdir: true, sync: false }),
  );
  return logger;
}

export function log(): Logger {
  return logger;
}
