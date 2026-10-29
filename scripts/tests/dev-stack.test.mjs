import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnvironment, composeConfiguration, ensurePrivateDirectory, loadConfig, portsFromEnvironment, privateFile, sourcePins } from "../dev-stack-config.mjs";
import { installedOpenCodeExecutable, matchesOpenCodeVersion, providerEnvironment } from "../dev-stack-opencode.mjs";
import { ownedProcessIds, ProcessSupervisor, stackReady, waitUntil } from "../dev-stack-processes.mjs";

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
  await writeFile(path.join(dir, ".dev-stack", "owner.json"), JSON.stringify({ root: "/another-checkout" }), { mode: 0o600 });
  await assert.rejects(loadConfig(dir), /ownership/);
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
