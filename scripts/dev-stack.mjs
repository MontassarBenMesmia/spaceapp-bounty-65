#!/usr/bin/env node
import { createServer } from "node:net";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { childEnvironment, composeConfiguration, dockerEnvironment, ensurePrivateDirectory, initialize, loadConfig } from "./dev-stack-config.mjs";
import { healthyHttp, ProcessSupervisor, stackReady, waitUntil } from "./dev-stack-processes.mjs";
import { installedOpenCodeExecutable, matchesOpenCodeVersion, providerEnvironment } from "./dev-stack-opencode.mjs";
import { acquireStateLock, releaseStateLock, removeLockedState, requestControl as control, unlinkOwnedSocket } from "./dev-stack-control.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let command = process.argv[2] ?? "up";
const sharedPackages = ["contracts", "icons", "streaming", "opencode-control", "memory-graph", "browser-host", "cli-host", "codex-app-server", "runtime", "db", "gateway"];

async function writeOwned(filename, content, mode = 0o600) {
  try {
    const existing = await lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)) throw new Error(`Unsafe generated file: ${filename}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); } finally { await handle.close(); }
  await chmod(filename, mode);
}

async function assertFreePorts(ports) {
  for (const [name, port] of Object.entries(ports)) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", () => reject(new Error(`${name} port ${port} is in use; set SPACE_DEV_${name.toUpperCase()}_PORT`)));
      server.listen(port, "127.0.0.1", () => server.close(resolve));
    });
  }
}

async function main() {
  if (!new Set(["up", "down", "reset", "status", "rebuild"]).has(command)) throw new Error("Usage: npm run dev:stack -- [up|down|reset|status|rebuild]");
  if (process.platform === "win32") throw new Error("Use a Linux filesystem inside WSL2, not native Windows Node");
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor !== 22 || nodeMinor < 12) throw new Error("Use Node 22.12+ (below 23), as required by .nvmrc");
  let config;
  try { config = await loadConfig(root, process.env, command === "up"); }
  catch (error) { if (error.code === "ENOENT" && command !== "up") { console.log("No development stack state exists."); return; } throw error; }
  if (Buffer.byteLength(config.socket) > 100) throw new Error("Checkout path is too long for Unix sockets; move this checkout to a shorter Linux path");
  if (command === "status" || command === "down") {
    try { await control(config, command); console.log(command === "down" ? "Development stack stopped." : "Development supervisor is running."); }
    catch (error) { if (["ENOENT", "ECONNREFUSED"].includes(error.code)) console.log("No live supervisor. Use reset to clean owned Docker resources."); else throw error; }
    return;
  }
  if (command === "rebuild") {
    try { await control(config, "down"); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
    command = "up";
  }
  if (command === "reset") {
    try { await control(config, "down"); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
    // Reset owns the same exclusive lock as startup, so another command cannot start during deletion.
    const resetLock = await acquireStateLock(config);
    try {
      const secrets = await initialize(config);
      const supervisor = new ProcessSupervisor(config, childEnvironment(config, secrets));
      await writeOwned(path.join(config.state, "compose.json"), `${JSON.stringify(composeConfiguration(config), null, 2)}\n`);
      await supervisor.run("reset", "docker", ["compose", "-p", config.project, "-f", path.join(config.state, "compose.json"), "down", "--volumes", "--remove-orphans"], { env: dockerEnvironment(supervisor.env) });
      await removeLockedState(config, resetLock);
    } finally { await releaseStateLock(resetLock); }
    console.log("Removed only this checkout's development containers, volumes, and state.");
    return;
  }

  const lock = await acquireStateLock(config);
  let secrets;
  try { secrets = await initialize(config); }
  catch (error) { await releaseStateLock(lock); throw error; }
  const supervisor = new ProcessSupervisor(config, childEnvironment(config, secrets));
  const composeArgs = ["compose", "-p", config.project, "-f", path.join(config.state, "compose.json")];
  let server;
  let socketIdentity;
  let stopped = false;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    stopped = true;
    await supervisor.stop();
    const cleanupSupervisor = new ProcessSupervisor(config, supervisor.env);
    await cleanupSupervisor.run("docker-stop", "docker", [...composeArgs, "stop", "--timeout", "10"], { env: dockerEnvironment(supervisor.env) });
  })();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  try {
    await writeOwned(path.join(config.state, "compose.json"), `${JSON.stringify(composeConfiguration(config), null, 2)}\n`);
    await assertFreePorts(config.ports);
    try { await unlink(config.socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
    server = createServer({ allowHalfOpen: true }, socket => {
      let received = "";
      socket.setTimeout(60000, () => socket.destroy());
      socket.on("data", chunk => {
        received += chunk;
        if (received.length > 2048) { socket.destroy(); return; }
        if (!received.includes("\n")) return;
        socket.removeAllListeners("data");
        void (async () => {
          const request = JSON.parse(received);
          if (request.token !== secrets.control || !["down", "status"].includes(request.action)) throw new Error("Invalid control request");
          if (request.action === "down") await cleanup();
          socket.end(JSON.stringify({ ok: true, generation: lock.generation }));
        })().catch(error => socket.end(JSON.stringify({ ok: false, error: error.message })));
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.socket, resolve); });
    await chmod(config.socket, 0o600);
    socketIdentity = await lstat(config.socket);
    console.log("Building workspace dependencies (first startup can take several minutes)...");
    for (const name of sharedPackages) await supervisor.run(`build-${name}`, "npm", ["run", "build", "-w", `@space/${name}`]);
    await supervisor.run("build-worker", "npm", ["run", "build", "-w", "@space/worker"]);
    for (const dir of ["config", "data", "cache", "state"]) await ensurePrivateDirectory(config.state, `providers/opencode/${dir}`);
    const vendor = await ensurePrivateDirectory(config.state, "vendor/opencode");
    const expectedVersion = config.pins.opencode.split("@").at(-1);
    const verifyOpenCode = async () => {
      const executable = await installedOpenCodeExecutable(vendor, expectedVersion);
      if (!executable) return false;
      try {
        await supervisor.run("verify-opencode", executable, ["--version"], { env: providerEnvironment(config.state, secrets.opencode, supervisor.env), timeoutMs: 15000 });
        const output = await readFile(path.join(config.state, "logs", "verify-opencode.log"), "utf8");
        return matchesOpenCodeVersion(output, expectedVersion);
      } catch { supervisor.assertHealthy(); return false; }
    };
    if (!await verifyOpenCode()) {
      // npm can leave package.json behind before the platform binary finishes downloading.
      // Remove only this validated, state-local install so npm cannot mistake a partial tree for a completed install.
      await rm(vendor, { recursive: true });
      await ensurePrivateDirectory(config.state, "vendor/opencode");
      await supervisor.run("install-opencode", "npm", ["install", "--prefix", vendor, "--no-audit", "--no-fund", "--save-exact", config.pins.opencode]);
      if (!await verifyOpenCode()) throw new Error("State-local OpenCode did not report the exact Dockerfile version after installation");
    }
    const wrapper = `#!${process.execPath}\nimport { runOpenCode } from ${JSON.stringify(new URL("./dev-stack-opencode.mjs", import.meta.url).href)};\nawait runOpenCode(${JSON.stringify(config.state)}, ${config.ports.opencode}, process.argv.slice(2));\n`;
    await writeOwned(path.join(config.state, "bin", "opencode-vscode-parity"), wrapper, 0o700);
    console.log("Starting checkout-owned PostgreSQL and Temporal...");
    await supervisor.run("docker-up", "docker", [...composeArgs, "up", "--detach", "--wait", "--wait-timeout", "240"], { env: dockerEnvironment(supervisor.env) });
    await supervisor.run("temporal-namespace", "docker", [...composeArgs, "exec", "-T", "temporal", "temporal", "operator", "namespace", "describe", "--namespace", "spaceapp-dev", "--address", "temporal:7233"], { env: dockerEnvironment(supervisor.env) }).catch(async () => {
      await supervisor.run("temporal-create-namespace", "docker", [...composeArgs, "exec", "-T", "temporal", "temporal", "operator", "namespace", "create", "--namespace", "spaceapp-dev", "--address", "temporal:7233"], { env: dockerEnvironment(supervisor.env) });
    });
    await supervisor.run("migrate", process.execPath, ["packages/db/dist/migrate.js"]);
    await supervisor.start("cli-host", process.execPath, ["packages/cli-host/dist/main.js"]);
    await supervisor.start("opencode", path.join(config.state, "bin", "opencode-vscode-parity"), ["serve"]);
    await waitUntil("OpenCode server", async () => {
      const response = await fetch(`http://127.0.0.1:${config.ports.opencode}/api/info`, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${secrets.opencode}`).toString("base64")}` }, signal: AbortSignal.timeout(2000) });
      return response.ok;
    }, supervisor);
    await supervisor.start("worker", process.execPath, ["apps/worker/dist/worker.js"]);
    await supervisor.start("api", process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/server.ts"]);
    await supervisor.start("web", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--strictPort"], { cwd: path.join(root, "apps/web") });
    await waitUntil("API /readyz with database, worker and CLI host", () => healthyHttp(`http://127.0.0.1:${config.ports.api}/readyz`, stackReady), supervisor);
    await waitUntil("Vite", async () => (await fetch(`http://127.0.0.1:${config.ports.web}`, { signal: AbortSignal.timeout(2000) })).ok, supervisor);
    console.log(`SpaceApp source stack: http://127.0.0.1:${config.ports.web}\nOne-time owner setup token: ${secrets.setup}\nToken expires 15 minutes after API startup. Stop: npm run dev:stack -- down`);
    while (!stopped) { supervisor.assertHealthy(); await delay(300); }
  } finally {
    let clean = false;
    try { await cleanup(); clean = true; } finally {
      // No successor may acquire the lock until this server and its pathname are gone.
      // Inode and generation checks also protect a successor if the old lock was manually replaced.
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (socketIdentity) await unlinkOwnedSocket(config.socket, socketIdentity, lock);
      if (clean) await releaseStateLock(lock);
    }
  }
}

main().catch(error => { console.error(`dev:stack: ${error.message}`); process.exitCode = 1; });
