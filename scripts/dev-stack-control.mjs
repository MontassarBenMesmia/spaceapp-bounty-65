import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { lstat, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateFile, readPrivateFile } from "./dev-stack-config.mjs";

export async function acquireStateLock(config) {
  const directory = path.join(config.state, "running.lock");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("A development stack already owns this state (or its lock needs manual recovery); try status/down first");
    throw error;
  }
  const generation = randomBytes(24).toString("hex");
  try { await privateFile(path.join(directory, "owner"), () => generation); }
  catch (error) { await rm(directory, { recursive: true }); throw error; }
  return { directory, generation };
}

export async function ownsStateLock(lock) {
  try { return await readPrivateFile(path.join(lock.directory, "owner")) === lock.generation; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function releaseStateLock(lock) {
  if (!await ownsStateLock(lock)) return false;
  await rm(lock.directory, { recursive: true });
  return true;
}

export async function removeLockedState(config, lock) {
  if (!await ownsStateLock(lock)) throw new Error("Reset lost its state ownership; refusing deletion");
  for (const entry of await readdir(config.state)) {
    if (entry === "running.lock") continue;
    if (!await ownsStateLock(lock)) throw new Error("Reset lost its state ownership; refusing deletion");
    await rm(path.join(config.state, entry), { recursive: true });
  }
  await releaseStateLock(lock);
  // A new start may now create its own state. Never recursively remove anything after releasing the lock.
  try { await rmdir(config.state); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}

export async function unlinkOwnedSocket(filename, identity, lock) {
  if (!await ownsStateLock(lock)) return false;
  try {
    const current = await lstat(filename);
    if (!current.isSocket() || current.ino !== identity.ino || current.dev !== identity.dev) return false;
    await unlink(filename);
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function waitForShutdown(config, generation) {
  if (!/^[a-f0-9]{48}$/.test(generation ?? "")) throw new Error("Supervisor did not identify its shutdown generation");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const directory = path.join(config.state, "running.lock");
    try {
      const current = await readPrivateFile(path.join(directory, "owner"));
      if (current !== generation) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Recursive lock removal unlinks its owner file first; wait until the directory is gone too.
      try { await lstat(directory); }
      catch (statError) { if (statError.code === "ENOENT") return; throw statError; }
    }
    await delay(25);
  }
  throw new Error("Supervisor acknowledged shutdown but did not release its control socket and state lock");
}

export async function requestControl(config, action) {
  const token = await readPrivateFile(path.join(config.state, "secrets", "control"));
  const socketInfo = await lstat(config.socket);
  if (!socketInfo.isSocket() || (socketInfo.mode & 0o077) || (process.getuid && socketInfo.uid !== process.getuid())) throw new Error("Unsafe supervisor control socket");
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(config.socket);
    let received = "";
    socket.setTimeout(60000, () => socket.destroy(new Error("Supervisor did not respond")));
    socket.once("connect", () => socket.end(`${JSON.stringify({ token, action })}\n`));
    socket.on("data", chunk => { received += chunk; if (received.length > 4096) socket.destroy(new Error("Invalid supervisor response")); });
    socket.once("error", reject);
    socket.once("end", () => {
      try { const message = JSON.parse(received); message.ok ? resolve(message) : reject(new Error(message.error)); } catch (error) { reject(error); }
    });
  });
  if (action === "down") await waitForShutdown(config, response.generation);
  return response;
}
