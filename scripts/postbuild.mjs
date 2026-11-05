// Ensure the CLI entry is executable after compilation.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
const entry = new URL("../dist/index.js", import.meta.url);
const src = readFileSync(entry, "utf8");
if (!src.startsWith("#!")) writeFileSync(entry, "#!/usr/bin/env node\n" + src);
chmodSync(entry, 0o755);
