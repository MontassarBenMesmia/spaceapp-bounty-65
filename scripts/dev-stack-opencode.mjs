import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readPrivateFile } from "./dev-stack-config.mjs";

export function matchesOpenCodeVersion(output, expectedVersion) {
  const line = output.trim().split(/\r?\n/).at(-1);
  return line === expectedVersion || line === `opencode v${expectedVersion}`;
}

export async function installedOpenCodeExecutable(vendor, expectedVersion) {
  try {
    const installed = JSON.parse(await readFile(path.join(vendor, "node_modules", "@opencode", "cli", "package.json"), "utf8"));
    if (installed.version !== expectedVersion) return null;
    const executable = path.join(vendor, "node_modules", ".bin", "opencode");
    await access(executable, constants.X_OK);
    const resolved = await realpath(executable);
    if (!resolved.startsWith(`${await realpath(vendor)}${path.sep}`)) return null;
    return executable;
  } catch { return null; }
}

export function providerEnvironment(state, password, inherited = process.env) {
  const root = path.join(state, "providers", "opencode");
  const env = {
    PATH: inherited.PATH, TERM: inherited.TERM ?? "xterm-256color", LANG: inherited.LANG ?? "C.UTF-8",
    HOME: path.join(state, "home"), TMPDIR: path.join(state, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password
  };
  return env;
}

export async function runOpenCode(state, port, args) {
  const executable = path.join(state, "vendor", "opencode", "node_modules", ".bin", "opencode");
  if (args[0] === "credential-status") {
    await access(executable, constants.X_OK);
    console.log("READY");
    return;
  }
  if (args[0] === "credential-observation") {
    console.log("OBSERVATION:MISSING");
    return;
  }
  if (args[0] === "credential-smoke") throw new Error("Provider inference is not part of source-stack readiness");
  const password = await readPrivateFile(path.join(state, "secrets", "opencode"));
  const cliArgs = args[0] === "serve"
    ? ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
    : args.some(arg => ["--help", "--version", "-h", "-v"].includes(arg)) ? args
      : ["--server", `http://127.0.0.1:${port}`, ...args];
  const child = spawn(executable, cliArgs, { env: providerEnvironment(state, password), stdio: "inherit", shell: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { process.exitCode = code ?? 1; resolve(); });
  });
}
