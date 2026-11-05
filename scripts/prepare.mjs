// Runs on `npm install` from a git checkout or `npm install -g github:cneuralnetwork/sutra`.
//
// For a global install from GitHub, npm runs this step with the global flag
// still set, so the package's own (dev) dependencies are never installed and
// the TypeScript build can't run. Install them locally first, then build.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url);
const env = { ...process.env, npm_config_global: "false", npm_config_location: "project" };
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit", env });

if (!existsSync(new URL("node_modules/typescript/package.json", root))) {
  run("npm install --global=false --include=dev --ignore-scripts --no-audit --no-fund --no-save");
}
run("npm run build");
