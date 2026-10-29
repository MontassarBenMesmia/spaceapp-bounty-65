import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { childEnvironment, composeConfiguration, ensurePrivateDirectory, loadConfig, portsFromEnvironment, privateFile, projectForState, sourcePins } from "../dev-stack-config.mjs";
import { installedOpenCodeExecutable, matchesOpenCodeVersion, providerEnvironment } from "../dev-stack-opencode.mjs";
import { ownedProcessIds, ProcessSupervisor, stackReady, waitUntil } from "../dev-stack-processes.mjs";
import { acquireStateLock, releaseStateLock, removeLockedState, requestControl, unlinkOwnedSocket } from "../dev-stack-control.mjs";

const temporary = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), "spaceapp-stack-")); temporary.push(dir); return dir; }
const config = { root: path.resolve("/checkout"), state: path.resolve("/checkout/.dev-stack"), identity: "test", ports: portsFromEnvironment({}), pins: { postgres: "postgres", temporal: "temporal" } };

test("ports reject injection, collisions, installed ports and unsafe ranges", () => {
  for (const value of ["14910;touch /tmp/no", "0", "65536", "4910", "14911", "1e4", " 14910"]) {
    assert.throws(() => portsFromEnvironment({ SPACE_DEV_API_PORT: value }));
  }
  assert.equal(portsFromEnvironment({ SPACE_DEV_API_PORT: "18080" }).api, 18080);
});

test("pins come from the maintained template and Dockerfile; unpinned inputs fail closed", async () => {
  const pins = sourcePins(await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url), "utf8"), await readFile(new URL("../../Dockerfile", import.meta.url), "utf8"));
  assert.match(pins.postgres, /@sha256:[a-f0-9]{64}$/);
  assert.match(pins.temporal, /@sha256:[a-f0-9]{64}$/);
  assert.match(pins.opencode, /^@opencode\/cli@\d+\.\d+\.\d+$/);
  assert.throws(() => sourcePins("image: postgres:latest", "npm install @opencode/cli@latest"));
  const compose = await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url), "utf8");
  assert.throws(() => sourcePins(compose, "npm install @opencode/cli@2.0.32-beta"), /exact OpenCode package pin/);
});

test("all published container ports are loopback; database password is a file secret", () => {
  const compose = composeConfiguration(config);
  for (const service of Object.values(compose.services)) for (const port of service.ports) assert.match(port, /^127\.0\.0\.1:/);
  assert.equal(compose.services.postgres.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(compose.services.postgres.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/database");
  assert.equal(compose.services.temporal.privileged, undefined);
  assert.match(compose.services.temporal.healthcheck.test[1], /--address temporal:7233/);
  assert.doesNotMatch(compose.services.temporal.healthcheck.test[1], /--address 127\.0\.0\.1/);
});

test("readiness rejects a green HTTP facade with disabled workflows or unavailable CLI host", () => {
  assert.equal(stackReady({ ok: true }), false);
  assert.equal(stackReady({ ok: true, dependencies: { database: "RUNNING", worker: "disabled", cliHost: "RUNNING" } }), false);
  assert.equal(stackReady({ ok: true, dependencies: { database: "RUNNING", worker: "RUNNING", cliHost: "UNAVAILABLE" } }), false);
  assert.equal(stackReady({ ok: true, dependencies: { database: "RUNNING", worker: "RUNNING", cliHost: "RUNNING" } }), true);
});

test("application and provider environments discard inherited credentials and installed state", () => {
  const inherited = { PATH: "/usr/bin", HOME: "/personal", CODEX_HOME: "/personal/codex", OPENAI_API_KEY: "do-not-copy", ANTHROPIC_API_KEY: "do-not-copy", SPACE_DEV_LOGIN: "true", SPACE_GOOGLE_CLIENT_SECRET: "do-not-copy" };
  const env = childEnvironment(config, { database: "password", session: "session" }, inherited);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SPACE_GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.HOME, path.join(config.state, "home"));
  assert.equal(env.SPACE_METRICS_TOKEN_FILE, path.join(config.state, "secrets", "metrics"));
  assert.equal(env.SPACE_CLI_API_BASE_URL, `http://127.0.0.1:${config.ports.api}`);
  const provider = providerEnvironment(config.state, "private", inherited);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_HOME", "SPACE_GOOGLE_CLIENT_SECRET"]) assert.equal(provider[key], undefined);
  for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) assert.ok(provider[key].startsWith(`${config.state}${path.sep}`));
});

test("private files preserve generated secrets and reject symlinks or permissive files", { skip: process.platform === "win32" }, async () => {
  const dir = await temp();
  const secret = path.join(dir, "secret");
  assert.equal(await privateFile(secret, () => "first"), "first");
  assert.equal(await privateFile(secret, () => "second"), "first");
  await symlink(secret, path.join(dir, "link"));
  await assert.rejects(privateFile(path.join(dir, "link"), () => "bad"), /Unsafe private file/);
  await writeFile(path.join(dir, "public"), "bad", { mode: 0o644 });
  await assert.rejects(privateFile(path.join(dir, "public"), () => "bad"), /Unsafe private file/);
});

test("state ownership rejects symlink escape and a copied checkout marker", { skip: process.platform === "win32" }, async () => {
  const dir = await temp();
  const outside = await temp();
  await symlink(outside, path.join(dir, ".dev-stack"));
  await assert.rejects(loadConfig(dir), /private real directory/);
  await rm(path.join(dir, ".dev-stack"));
  await mkdir(path.join(dir, ".dev-stack"), { mode: 0o700 });
  await writeFile(path.join(dir, ".dev-stack", "owner.json"), JSON.stringify({ version: 2, root: "/another-checkout", stateId: "a".repeat(24) }), { mode: 0o600 });
  await assert.rejects(loadConfig(dir), /ownership/);
});

test("identical checkout paths in independent states have different Docker projects", () => {
  const root = path.resolve("/home/contributor/spaceapp");
  const first = projectForState(root, "a".repeat(24));
  const second = projectForState(root, "b".repeat(24));
  assert.notEqual(first, second);
  assert.match(first, /^spaceapp-dev-[a-f0-9]{12}-[a-f0-9]{24}$/);
  for (const invalid of [undefined, "", "../other-project", "a".repeat(23), "g".repeat(24), `${"a".repeat(24)}\n`]) {
    assert.throws(() => projectForState(root, invalid), /ownership ID/);
  }
});

test("private ownership reloads preserve project identity while fresh state gets a new identity", { skip: process.platform === "win32" }, async () => {
  const root = await temp();
  await mkdir(path.join(root, "packages/run-spaceapp/templates"), { recursive: true });
  await writeFile(path.join(root, "packages/run-spaceapp/templates/compose.yml"), await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url)));
  await writeFile(path.join(root, "Dockerfile"), await readFile(new URL("../../Dockerfile", import.meta.url)));
  const first = await loadConfig(root);
  const reloaded = await loadConfig(root, {}, false);
  assert.equal(first.project, reloaded.project);
  assert.equal(first.stateId, reloaded.stateId);
  assert.equal((await lstat(path.join(first.state, "owner.json"))).mode & 0o777, 0o600);
  const markerPath = path.join(first.state, "owner.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, project: "neighbor-project" }));
  await assert.rejects(loadConfig(root, {}, false), /ownership/);
  await writeFile(markerPath, JSON.stringify({ ...marker, stateId: "invalid" }));
  await assert.rejects(loadConfig(root, {}, false), /ownership ID/);
  await rm(first.state, { recursive: true });
  const fresh = await loadConfig(root);
  assert.notEqual(first.stateId, fresh.stateId);
  assert.notEqual(first.project, fresh.project);
});

test("nested provider directories cannot escape through a symlink", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  const outside = await temp();
  await ensurePrivateDirectory(state, "providers");
  await symlink(outside, path.join(state, "providers", "opencode"));
  await assert.rejects(ensurePrivateDirectory(state, "providers/opencode/config"), /Unsafe state directory/);
  await assert.rejects(readFile(path.join(outside, "config")), error => error.code === "ENOENT");
  await assert.rejects(ensurePrivateDirectory(state, "../escape"), /Invalid state subdirectory/);
});

test("an interrupted OpenCode install with only package metadata is not ready", { skip: process.platform === "win32" }, async () => {
  const vendor = await temp();
  const metadata = path.join(vendor, "node_modules", "@opencode", "cli");
  await mkdir(metadata, { recursive: true });
  await writeFile(path.join(metadata, "package.json"), JSON.stringify({ version: "2.0.32" }));
  assert.equal(await installedOpenCodeExecutable(vendor, "2.0.32"), null);
  await mkdir(path.join(vendor, "node_modules", ".bin"));
  await symlink(path.join(metadata, "missing-binary"), path.join(vendor, "node_modules", ".bin", "opencode"));
  assert.equal(await installedOpenCodeExecutable(vendor, "2.0.32"), null);
  await rm(path.join(vendor, "node_modules", ".bin", "opencode"));
  await symlink(process.execPath, path.join(vendor, "node_modules", ".bin", "opencode"));
  assert.equal(await installedOpenCodeExecutable(vendor, "2.0.32"), null, "An executable outside the local install must not be accepted");
});

test("OpenCode version verification accepts official output and rejects nearby versions", () => {
  assert.equal(matchesOpenCodeVersion("opencode v2.0.32\n", "2.0.32"), true);
  assert.equal(matchesOpenCodeVersion("2.0.32\r\n", "2.0.32"), true);
  for (const output of ["opencode v2.0.320", "opencode v2.0.32-beta", "opencode v2.0.31", "unknown 2.0.32", "opencode v2.0.32 injected"]) {
    assert.equal(matchesOpenCodeVersion(output, "2.0.32"), false);
  }
});

test("a crashed child fails readiness promptly rather than hanging", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "logs"));
  const supervisor = new ProcessSupervisor({ root: state, state }, { PATH: process.env.PATH });
  try {
    await supervisor.start("worker", process.execPath, ["-e", "process.exit(7)"]);
    await assert.rejects(waitUntil("never ready", async () => false, supervisor, 10000), /worker exited \(7\)/);
  } finally { await supervisor.stop(); }
});

test("stop terminates a live supervised process", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "logs"));
  const supervisor = new ProcessSupervisor({ root: state, state }, { PATH: process.env.PATH });
  const child = await supervisor.start("idle", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await supervisor.stop();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH");
});

test("a missing executable reports failure and can be stopped safely", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "logs"));
  const supervisor = new ProcessSupervisor({ root: state, state }, { PATH: process.env.PATH });
  await assert.rejects(supervisor.run("missing", path.join(state, "nonexistent"), []), /ENOENT/);
  await supervisor.stop();
  assert.equal(supervisor.children.size, 0);
});

test("readiness aborts promptly when shutdown is requested during startup", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  const supervisor = new ProcessSupervisor({ root: state, state }, {});
  const readiness = waitUntil("not started", async () => false, supervisor, 10000);
  await supervisor.stop();
  await assert.rejects(readiness, /Development stack was stopped/);
});

test("shutdown during asynchronous log preparation cannot spawn a late child", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "logs"));
  const supervisor = new ProcessSupervisor({ root: state, state }, { PATH: process.env.PATH });
  const starting = supervisor.start("late-child", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await supervisor.stop();
  await assert.rejects(starting, /Stack is stopping/);
  assert.equal(supervisor.children.size, 0);
  assert.equal(supervisor.groups.size, 0);
});

test("a stuck version probe is bounded and its process is terminated", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "logs"));
  const supervisor = new ProcessSupervisor({ root: state, state }, { PATH: process.env.PATH });
  try {
    await assert.rejects(supervisor.run("version", process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }), /SIGKILL/);
  } finally { await supervisor.stop(); }
});

test("leftover process inspection matches exact state, including socket-only children", { skip: process.platform === "win32" }, async () => {
  const proc = await temp();
  const state = path.join(await temp(), ".dev-stack");
  for (const [pid, environment, cwd] of [
    ["101", `SPACE_INSTALL_ROOT=${state}/install\0PRIVATE_KEY=never-print\0`, "/checkout"],
    ["102", `HOME=${state}/home\0`, "/checkout"],
    ["103", "HOME=/unrelated\0", `${state}/workspaces/room`],
    ["104", `SPACE_INSTALL_ROOT=${state}-other/install\0`, `${state}-other/workspaces`]
  ]) {
    const directory = path.join(proc, pid);
    await mkdir(directory);
    await writeFile(path.join(directory, "environ"), environment);
    await symlink(cwd, path.join(directory, "cwd"));
  }
  assert.deepEqual(await ownedProcessIds(state, proc), [101, 102, 103]);
});

test("down waits for complete Unix control shutdown before a successor can start", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  await mkdir(path.join(state, "secrets"), { mode: 0o700 });
  const config = { state, socket: path.join(state, "control.sock") };
  const token = await privateFile(path.join(state, "secrets", "control"), () => "private-control-token");
  const lock = await acquireStateLock(config);
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.once("data", data => {
      const request = JSON.parse(data.toString());
      assert.equal(request.token, token);
      assert.equal(request.action, "down");
      socket.end(JSON.stringify({ ok: true, generation: lock.generation }));
    });
  });
  await new Promise(resolve => server.listen(config.socket, resolve));
  await chmod(config.socket, 0o600);
  const identity = await lstat(config.socket);
  let downCompleted = false;
  const down = requestControl(config, "down").then(() => { downCompleted = true; });
  await delay(75);
  assert.equal(downCompleted, false, "Acknowledgement alone must not let rebuild race the old finalizer");
  await assert.rejects(acquireStateLock(config), /already owns/);
  await new Promise(resolve => server.close(resolve));
  await unlinkOwnedSocket(config.socket, identity, lock);
  await releaseStateLock(lock);
  await down;
  const successor = await acquireStateLock(config);
  const successorServer = createServer();
  try {
    await new Promise(resolve => successorServer.listen(config.socket, resolve));
    await chmod(config.socket, 0o600);
    assert.equal(await releaseStateLock(lock), false, "Old finalization must not remove a successor lock");
    assert.equal(await unlinkOwnedSocket(config.socket, identity, lock), false, "Old finalization must not remove a successor socket");
    assert.equal((await lstat(config.socket)).isSocket(), true);
  } finally {
    await new Promise(resolve => successorServer.close(resolve));
    await releaseStateLock(successor);
  }
});

test("reset removes owned state while preserving a successor when old ownership is stale", { skip: process.platform === "win32" }, async () => {
  const state = await temp();
  const config = { state };
  const old = await acquireStateLock(config);
  await releaseStateLock(old);
  const successor = await acquireStateLock(config);
  await writeFile(path.join(state, "successor-data"), "preserve");
  await assert.rejects(removeLockedState(config, old), /lost its state ownership/);
  assert.equal(await readFile(path.join(state, "successor-data"), "utf8"), "preserve");
  await removeLockedState(config, successor);
  await assert.rejects(lstat(state), error => error.code === "ENOENT");
});

test("a port conflict before Compose startup does not invoke Docker cleanup", { skip: process.platform === "win32" }, async () => {
  const root = await temp();
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "packages/run-spaceapp/templates"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  for (const name of ["dev-stack.mjs", "dev-stack-config.mjs", "dev-stack-control.mjs", "dev-stack-processes.mjs", "dev-stack-opencode.mjs"]) {
    await writeFile(path.join(root, "scripts", name), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  await writeFile(path.join(root, "packages/run-spaceapp/templates/compose.yml"), await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url)));
  await writeFile(path.join(root, "Dockerfile"), await readFile(new URL("../../Dockerfile", import.meta.url)));
  const called = path.join(root, "docker-was-called");
  const fakeDocker = path.join(root, "bin", "docker");
  await writeFile(fakeDocker, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(called)}, "called");\n`, { mode: 0o700 });
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.join(root, "scripts", "dev-stack.mjs")], {
    cwd: root, shell: false, env: { PATH: `${path.join(root, "bin")}:${process.env.PATH}`, SPACE_DEV_API_PORT: String(listener.address().port) }, stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    assert.equal(code, 1);
    assert.match(stderr, /port .* is in use/);
    await assert.rejects(lstat(called), error => error.code === "ENOENT");
    await assert.rejects(lstat(path.join(root, ".dev-stack", "running.lock")), error => error.code === "ENOENT");
  } finally { clearTimeout(timer); await new Promise(resolve => listener.close(resolve)); }
});
