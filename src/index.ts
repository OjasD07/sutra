#!/usr/bin/env node
// Entry point. Colour settings must be fixed before chalk/ink are loaded,
// so everything else is imported dynamically.
const argv = process.argv.slice(2);
if (argv.includes("--no-color") || process.env.NO_COLOR !== undefined) {
  process.env.FORCE_COLOR = "0";
}

const [major, minor] = process.versions.node.split(".").map(Number);
if ((major ?? 0) < 22 || (major === 22 && (minor ?? 0) < 13)) {
  process.stderr.write(`Sutra requires Node.js 22.13 or later (found ${process.versions.node}).\n`);
  process.exit(1);
}

// node:sqlite prints an ExperimentalWarning on some Node versions; keep the UI clean.
const origEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (origEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./cli/main.js");
const code = await main(argv);
process.exitCode = code;
