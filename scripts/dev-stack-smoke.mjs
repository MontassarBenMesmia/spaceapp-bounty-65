#!/usr/bin/env node
// Real local acceptance: no mocked services, provider keys, inference calls or TTY.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { loadConfig, portsFromEnvironment } from "./dev-stack-config.mjs";
import { ownedProcessIds } from "./dev-stack-processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts", "dev-stack.mjs");
const ports = portsFromEnvironment(process.env);
const origin = `http://127.0.0.1:${ports.web}`;
let stack;
let cookie;
let csrf;
let config;

function startRunner(args = []) {
  const child = spawn(process.execPath, [runner, ...args], { cwd: root, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  child.runnerClosed = false;
  child.once("error", error => { child.runnerFailure = error; });
  child.once("exit", code => { child.runnerFailure = new Error(`Development runner exited ${code}`); });
  child.once("close", () => { child.runnerClosed = true; });
  child.stdout.resume(); // Never echo the one-time owner setup token into CI output.
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  return child;
}

async function waitForRunnerClose(child) {
  if (child.runnerClosed) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Previous supervisor did not finish shutdown")), 60000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForReadyStack() {
  const deadline = Date.now() + 12 * 60000;
  while (Date.now() < deadline) {
    if (stack.runnerFailure) throw stack.runnerFailure;
    try {
      const ready = await request("/readyz", undefined, false);
      if (ready.ok) return ready;
    } catch { /* startup */ }
    await delay(1000);
  }
  throw new Error("Real stack did not become ready before the acceptance deadline");
}

async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: root, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${args[0]} ${args[1]} exited ${code}; inspect local logs`)));
  });
}

async function request(route, body, authenticated = true) {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authenticated && cookie ? { cookie } : {}), ...(csrf && authenticated ? { "x-space-csrf-token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}

async function realTui(paneId, session) {
  assert.ok(session.websocket?.token, "API must issue a real WebSocket ticket");
  const query = new URLSearchParams({ sessionId: session.session.sessionId, token: session.websocket.token, initialCols: "100", initialRows: "30" });
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/panes/${paneId}/cli/terminal?${query}`, { headers: { cookie, origin } });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("No real OpenCode TUI appeared within 60 seconds")), 60000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket.on("error", finish);
      socket.on("message", data => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === "output") output += frame.data;
          const visible = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
          if (/opencode|open code/i.test(visible) && output.includes("\u001b[")) finish();
          if (frame.type === "status" && ["EXITED", "ERROR"].includes(frame.status)) finish(new Error(`OpenCode session ${frame.status}`));
        } catch (error) { finish(error); }
      });
    });
  } finally { socket.close(); }
}

async function portIsClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000, () => socket.destroy(new Error(`Port ${port} did not answer`)));
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => error.code === "ECONNREFUSED" ? resolve(true) : reject(error));
  });
}

async function main() {
  try { await access(path.join(root, ".dev-stack")); throw new Error("Acceptance requires fresh state; explicitly reset your development stack before running this test"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  stack = startRunner();
  try {
    const ready = await waitForReadyStack();
    assert.equal(ready?.ok, true, "Real stack must become ready");
    assert.equal(ready.dependencies.database, "RUNNING");
    assert.equal(ready.dependencies.worker, "RUNNING");
    assert.equal(ready.dependencies.cliHost, "RUNNING");
    config = await loadConfig(root, process.env, false);
    const token = await readFile(path.join(config.state, "secrets", "setup"), "utf8");
    const email = "contributor@example.invalid";
    const password = randomBytes(24).toString("hex");
    const claimed = await request("/api/setup/claim", { token, email, password }, false);
    assert.equal(claimed.user.role, "ADMIN");
    cookie = undefined;
    const login = await request("/api/auth/login", { email, password }, false);
    assert.ok(cookie, "Normal owner password login must issue a cookie");
    assert.ok(login, "Normal login must return a response");
    csrf = (await request("/api/auth/csrf")).csrfToken;
    const starter = await request("/api/setup/starter-room", {});
    assert.equal(starter.room.name, "Getting Started");
    const panes = await request(`/api/rooms/${starter.room.id}/panes`, { panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:opencode" }] });
    const pane = panes.data[0];
    const session = await request(`/api/panes/${pane.id}/cli/session`, { runtimeId: "cli:opencode" });
    await realTui(pane.id, session);
    const running = await request(`/api/panes/${pane.id}/cli/session`);
    assert.equal(running.session.status, "RUNNING");
    console.log("PASS: PostgreSQL, Temporal worker, normal owner claim/sign-in, Getting Started room, source CLI host, real OpenCode TUI via Vite WebSocket proxy.");
    const previous = stack;
    stack = startRunner(["rebuild"]);
    await waitForRunnerClose(previous);
    const rebuilt = await waitForReadyStack();
    assert.notEqual(rebuilt.apiStartedAt, ready.apiStartedAt, "Rebuild must start a fresh source API");
    await command([process.execPath, runner, "status"]);
    cookie = undefined;
    csrf = undefined;
    const relogin = await request("/api/auth/login", { email, password }, false);
    assert.equal(relogin.user.email, email);
    assert.ok(cookie);
    console.log("PASS: real rebuild completed shutdown, rebuilt source packages, retained its control socket and preserved owner credentials.");
  } finally {
    await command([process.execPath, runner, "reset"]);
    await waitForRunnerClose(stack);
    await assert.rejects(access(path.join(root, ".dev-stack")), error => error.code === "ENOENT");
    if (config) {
      const filter = `label=com.docker.compose.project=${config.project}`;
      assert.equal(await command(["docker", "ps", "-aq", "--filter", filter]), "");
      assert.equal(await command(["docker", "volume", "ls", "-q", "--filter", filter]), "");
      if (process.platform === "linux") {
        let remaining = [];
        const deadline = Date.now() + 5000;
        do {
          remaining = await ownedProcessIds(config.state);
          if (!remaining.length) break;
          await delay(100);
        } while (Date.now() < deadline);
        assert.deepEqual(remaining, [], "No process with this state's exact environment or working directory may remain after reset");
      }
    }
    for (const port of Object.values(ports)) {
      assert.equal(await portIsClosed(port), true, `Port ${port} must have no listener after reset`);
    }
    console.log("PASS: reset removed owned containers, volumes, state and listeners.");
  }
}

main().catch(error => { console.error(`dev:stack acceptance: ${error.message}`); process.exitCode = 1; });
