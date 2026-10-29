import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class ProcessSupervisor {
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this.children = new Set();
    this.groups = new Set();
    this.failure = null;
    this.stopping = false;
  }

  async start(name, executable, args, options = {}) {
    if (this.stopping) throw new Error("Stack is stopping");
    const filename = path.join(this.config.state, "logs", `${name}.log`);
    const log = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const info = await lstat(filename);
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) { await log.close(); throw new Error(`Unsafe log file: ${filename}`); }
    if (this.stopping) { await log.close(); throw new Error("Stack is stopping"); }
    const { oneshot } = options;
    const child = spawn(executable, args, {
      cwd: options.cwd ?? this.config.root, env: options.env ?? this.env, shell: false, detached: true,
      stdio: ["ignore", log.fd, log.fd]
    });
    this.children.add(child);
    if (Number.isSafeInteger(child.pid)) this.groups.add(child.pid);
    child.once("error", error => {
      this.children.delete(child);
      this.failure ??= new Error(`${name} failed: ${error.message}`);
    });
    child.once("close", () => {
      this.children.delete(child);
      if (oneshot) this.groups.delete(child.pid);
      void log.close();
    });
    child.once("exit", (code, signal) => {
      this.children.delete(child);
      if (!this.stopping && !oneshot) this.failure ??= new Error(`${name} exited (${signal ?? code}); see .dev-stack/logs/${name}.log`);
    });
    return child;
  }

  async run(name, executable, args, options = {}) {
    const child = await this.start(name, executable, args, { ...options, oneshot: true });
    let timer;
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} failed (${signal ?? code}); see .dev-stack/logs/${name}.log`)));
        if (options.timeoutMs) timer = setTimeout(() => {
          if (!Number.isSafeInteger(child.pid)) return;
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); }
        }, options.timeoutMs);
      });
    } finally { clearTimeout(timer); }
    this.assertHealthy();
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
    if (this.stopping) throw new Error("Development stack was stopped");
  }

  async stop() {
    this.stopping = true;
    const children = [...this.children];
    const groups = [...this.groups];
    const signal = (pid, name) => {
      if (!Number.isSafeInteger(pid)) return;
      try { process.kill(-pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    for (const pid of groups) signal(pid, "SIGTERM");
    const deadline = Date.now() + 8000;
    while (this.children.size && Date.now() < deadline) await delay(100);
    // Descendants can remain even when their immediate parent has exited.
    for (const pid of groups) signal(pid, "SIGKILL");
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once("exit", resolve))));
  }
}

export async function waitUntil(label, check, supervisor, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    supervisor.assertHealthy();
    try { if (await check()) return; } catch { /* dependency is not listening yet */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label}; inspect .dev-stack/logs`);
}

export async function healthyHttp(url, predicate = body => body.ok === true) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return response.ok && predicate(await response.json());
}

export function stackReady(body) {
  return body.ok === true && body.dependencies?.database === "RUNNING" &&
    body.dependencies?.worker === "RUNNING" && body.dependencies?.cliHost === "RUNNING";
}

export async function ownedProcessIds(state, procRoot = "/proc") {
  const ids = [];
  const markers = new Set([
    `SPACE_INSTALL_ROOT=${path.join(state, "install")}`,
    `HOME=${path.join(state, "home")}`,
    `XDG_STATE_HOME=${path.join(state, "providers", "opencode", "state")}`
  ]);
  for (const entry of await readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const directory = path.join(procRoot, entry);
    try {
      const environment = (await readFile(path.join(directory, "environ"), "utf8")).split("\0");
      if (environment.some(value => markers.has(value))) { ids.push(Number(entry)); continue; }
      // A terminal wrapper may keep the API's narrow environment while its cwd is an owned room.
      const cwd = await readlink(path.join(directory, "cwd"));
      if (cwd === state || cwd.startsWith(`${state}${path.sep}`)) ids.push(Number(entry));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return ids;
}
