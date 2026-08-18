/**
 * Packages the extension and installs the resulting VSIX locally.
 *
 * Exists because the VSIX filename carries the version, and computing it inline
 * in a VS Code task would need shell substitution — which is `$(…)` on POSIX and
 * something else in cmd/PowerShell, i.e. a task that only works on the machine it
 * was written on. Node runs the same everywhere.
 *
 * Usage: node scripts/install-vsix.cjs [--insiders] [--skip-package]
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { version, name } = require(path.join("..", "package.json"));

const args = process.argv.slice(2);
const cli = args.includes("--insiders") ? "code-insiders" : "code";
const vsix = `${name}-${version}.vsix`;

const run = (command, commandArgs) => {
  // `shell: true` is what lets a Windows shim (code.cmd, npx.cmd) be found at all.
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(" ")} 失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
};

if (!args.includes("--skip-package")) run("npx", ["vsce", "package"]);
run(cli, ["--install-extension", vsix, "--force"]);
console.log(`\n已安装 ${vsix} 到 ${cli}。请完全退出并重新启动 ${cli === "code-insiders" ? "VS Code Insiders" : "VS Code"} 后再验证。`);
