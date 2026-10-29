import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const installedOAuth = vi.hoisted(() => ({ reads: vi.fn(), probes: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (filename: string) => {
      if (filename === "/opt/spaceapp/secrets/google-oauth.json") { installedOAuth.probes(); return true; }
      return actual.existsSync(filename);
    },
    readFileSync: (filename: string, ...args: unknown[]) => {
      if (filename === "/opt/spaceapp/secrets/google-oauth.json") {
        installedOAuth.reads();
        return JSON.stringify({ clientId: "installed-client", clientSecret: "installed-private-secret" });
      }
      return Reflect.apply(actual.readFileSync, actual, [filename, ...args]);
    }
  };
});

import { getAuthConfig } from "../src/auth.js";
import { collectStorageReadiness } from "../src/storage-readiness.js";
import { getApiConfig } from "../src/config.js";

describe("source development isolation", () => {
  it("keeps every background job, including new monitoring jobs, off by default", () => {
    const config = getApiConfig({ SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_OPTIONAL_MODULES: "none", SPACE_ROOM_AGENT_MONITOR_ENABLED: "false" });
    expect(Object.values(config.instanceJobs).every(enabled => !enabled)).toBe(true);
    expect(config.instanceJobs["monitoring-copilot-watch"]).toBe(false);
    expect(config.optionalModules.size).toBe(0);
    expect(config.roomAgentMonitorEnabled).toBe(false);
  });
  it("does not discover an installed Google client when Google auth is disabled", () => {
    installedOAuth.reads.mockClear();
    installedOAuth.probes.mockClear();
    const config = getAuthConfig({ SPACE_GOOGLE_AUTH_DISABLED: "true", SPACE_DEV_LOGIN: "false" });
    expect(config.googleClientId).toBeUndefined();
    expect(config.googleClientSecret).toBeUndefined();
    expect(config.devLogin).toBe(false);
    expect(installedOAuth.probes).not.toHaveBeenCalled();
    expect(installedOAuth.reads).not.toHaveBeenCalled();
  });

  it("preserves installed OAuth discovery when it has not been disabled", () => {
    const config = getAuthConfig({});
    expect(config.googleClientId).toBe("installed-client");
    expect(config.googleClientSecret).toBe("installed-private-secret");
  });

  it("reports the configured source installation storage without requiring /opt/spaceapp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spaceapp-storage-"));
    try {
      const readiness = await collectStorageReadiness(directory);
      expect(readiness.app.path).toBe(directory);
      expect(readiness.app.sizeBytes).toBeGreaterThan(0);
      expect(readiness.root.path).toBe("/");
    } finally { await rm(directory, { recursive: true }); }
  });
});
