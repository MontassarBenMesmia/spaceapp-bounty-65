import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const portDefaults = { api: 14910, web: 14911, postgres: 15432, temporal: 17233, opencode: 14096 };

export function projectForState(root, stateId) {
  if (typeof stateId !== "string" || !/^[a-f0-9]{24}$/.test(stateId)) throw new Error("Invalid development state ownership ID");
  const identity = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `spaceapp-dev-${identity}-${stateId}`;
}

export function portsFromEnvironment(env) {
  const ports = Object.fromEntries(Object.entries(portDefaults).map(([name, fallback]) => {
    const value = env[`SPACE_DEV_${name.toUpperCase()}_PORT`] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`Invalid ${name} port`);
    return [name, Number(value)];
  }));
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length || Object.values(ports).some(port => [4910, 4911, 5432, 7233].includes(port))) {
    throw new Error("Development ports must be distinct and must not use installed-stack ports");
  }
  return ports;
}

export function sourcePins(compose, dockerfile) {
  const image = name => {
    const value = compose.match(new RegExp(`image:\\s*(${name}[^\\s]+)`))?.[1];
    if (!value || !/@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Missing digest-pinned ${name} image`);
    return value;
  };
  const opencode = dockerfile.match(/npm install[^\n]*?(@opencode\/cli@\d+\.\d+\.\d+)(?=\s|\\|$)/)?.[1];
  if (!opencode) throw new Error("Dockerfile has no exact OpenCode package pin");
  return { postgres: image("pgvector/pgvector:"), temporal: image("temporalio/auto-setup:"), opencode };
}

export async function privateFile(filename, createValue) {
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(createValue());
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally { await handle?.close(); }
  return readPrivateFile(filename);
}

export async function readPrivateFile(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 4096 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`Unsafe private file permissions: ${filename}`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`Unsafe private file symlink: ${filename}`);
    throw error;
  } finally { await handle?.close(); }
}

export async function loadConfig(root, env = process.env, create = true) {
  root = await realpath(root);
  const state = path.join(root, ".dev-stack");
  if (create) await mkdir(state, { mode: 0o700, recursive: true });
  const info = await lstat(state);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(state) !== state || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(".dev-stack must be an owned, private real directory (use a Linux filesystem under WSL2)");
  }
  const identity = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const marker = path.join(state, "owner.json");
  const recorded = create ? await privateFile(marker, () => JSON.stringify({ version: 2, root, stateId: randomBytes(12).toString("hex") })) : await readPrivateFile(marker);
  const markerInfo = await lstat(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o077)) throw new Error("Unsafe state ownership marker");
  let owner;
  try { owner = JSON.parse(recorded); } catch { throw new Error("Invalid development state ownership marker"); }
  if (!owner || owner.version !== 2 || owner.root !== root || Object.keys(owner).sort().join(",") !== "root,stateId,version") throw new Error("State ownership does not match this checkout; refusing cleanup");
  const project = projectForState(root, owner.stateId);
  const pins = sourcePins(await readFile(path.join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8"), await readFile(path.join(root, "Dockerfile"), "utf8"));
  const ports = portsFromEnvironment(env);
  return { root, state, identity, stateId: owner.stateId, project, pins, ports, socket: path.join(state, "control.sock") };
}

export async function initialize(config) {
  const { state } = config;
  for (const dir of ["secrets", "logs", "home", "tmp", "bin", "providers", "workspaces", "install", "memory", "artifacts", "projects", "vendor"]) {
    await ensurePrivateDirectory(state, dir);
  }
  const secrets = {};
  for (const name of ["database", "session", "setup", "control", "opencode"]) {
    secrets[name] = await privateFile(path.join(state, "secrets", name), () => randomBytes(32).toString("hex"));
    if (!/^[a-f0-9]{64}$/.test(secrets[name])) throw new Error(`Invalid ${name} secret`);
  }
  return secrets;
}

export async function ensurePrivateDirectory(state, relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("Invalid state subdirectory");
  let target = state;
  for (const part of parts) {
    target = path.join(target, part);
    try { await mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error(`Unsafe state directory: ${target}`);
  }
  return target;
}

export function composeConfiguration(config) {
  const { state, pins, ports } = config;
  return {
    services: {
      postgres: {
        image: pins.postgres,
        environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD_FILE: "/run/secrets/database" },
        secrets: ["database"],
        ports: [`127.0.0.1:${ports.postgres}:5432`],
        volumes: ["postgres:/var/lib/postgresql/data"],
        healthcheck: { test: ["CMD", "pg_isready", "-U", "spaceapp", "-d", "spaceapp_dev"], interval: "2s", timeout: "5s", retries: 90 }
      },
      temporal: {
        image: pins.temporal,
        user: "0:0",
        environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml" },
        entrypoint: ["/bin/sh", "-ec"],
        command: ['export POSTGRES_PWD="$$(cat /run/secrets/database)"; exec /etc/temporal/entrypoint.sh autosetup'],
        secrets: ["database"],
        depends_on: { postgres: { condition: "service_healthy" } },
        ports: [`127.0.0.1:${ports.temporal}:7233`],
        healthcheck: { test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"], interval: "3s", timeout: "10s", retries: 90 }
      }
    },
    volumes: { postgres: {} },
    secrets: { database: { file: path.join(state, "secrets", "database") } }
  };
}

export function childEnvironment(config, secrets, inherited = process.env) {
  const { state, ports, identity } = config;
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "CI"]) if (inherited[key]) env[key] = inherited[key];
  Object.assign(env, {
    HOME: path.join(state, "home"), TMPDIR: path.join(state, "tmp"), NODE_ENV: "development", ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_DEV_LOGIN: "false",
    SPACE_DATABASE_URL: `postgresql://spaceapp:${secrets.database}@127.0.0.1:${ports.postgres}/spaceapp_dev`, SPACE_RUNTIME_STORE: "postgres",
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev", SPACE_TEMPORAL_TASK_QUEUE: `spaceapp-dev-${identity}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true", SPACE_SESSION_SECRET: secrets.session, SPACE_SETUP_TOKEN_FILE: path.join(state, "secrets", "setup"),
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(ports.api), SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(ports.web), SPACE_API_ORIGIN: `http://127.0.0.1:${ports.api}`, SPACE_CLI_API_BASE_URL: `http://127.0.0.1:${ports.api}`,
    SPACE_INSTALL_ROOT: path.join(state, "install"), SPACE_CLI_ENABLED: "true", SPACE_CLI_HOST_SOCKET: path.join(state, "cli.sock"), SPACE_CLI_COMMAND_PATH: path.join(state, "bin"),
    SPACE_CLI_WORKSPACE_ROOT: path.join(state, "workspaces"), SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_OPENCODE_COMMAND: "opencode-vscode-parity",
    SPACE_CODEX_HOME: path.join(state, "providers", "codex"), SPACE_CODEX_APP_SERVER_HOME: path.join(state, "providers", "codex"),
    SPACE_FILES_HOST_MODE: "disabled", SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_T3CODE_ENABLED: "false", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_OPTIONAL_MODULES: "none", SPACE_GOOGLE_AUTH_DISABLED: "true",
    SPACE_ROOM_AGENT_MONITOR_ENABLED: "false", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false", SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_MEMORY_ROOT: path.join(state, "memory"), SPACE_MEMORY_GRAPH_ROOT: path.join(state, "memory", "graph"), SPACE_MEMORY_INDEX_PATH: path.join(state, "memory", "index.json"),
    SPACE_ARTIFACT_ROOT: path.join(state, "artifacts"), SPACE_PROJECTS_ROOT: path.join(state, "projects"),
    SPACE_APP_DIAGNOSTICS_ROOT: path.join(state, "diagnostics"), SPACE_TELEGRAM_SECRET_ROOT: path.join(state, "secrets", "telegram"), SPACE_STREAMING_SECRET_ROOT: path.join(state, "secrets", "streaming"),
    SPACE_CONNECTOR_KEY_FILE: path.join(state, "secrets", "connector"), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path.join(state, "telegram-ownership.json"),
    SPACE_METRICS_TOKEN_FILE: path.join(state, "secrets", "metrics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: path.join(state, "autopilot.json"), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: path.join(state, "balancer.json"),
    SPACE_CODEX_GOALS_DB_PATH: path.join(state, "goals.sqlite"), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: path.join(state, "codex-defaults.json")
  });
  return env;
}

export function dockerEnvironment(appEnvironment, inherited = process.env) {
  const env = { ...appEnvironment, DOCKER_CONFIG: inherited.DOCKER_CONFIG ?? path.join(inherited.HOME ?? os.homedir(), ".docker") };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) if (inherited[key]) env[key] = inherited[key];
  return env;
}
