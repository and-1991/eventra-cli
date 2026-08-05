import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_NAME,
  LOCAL_CONFIG_NAME,
  getTrustedEndpoint,
  loadConfig,
  normalizeConfig,
  resolveApiKey,
  saveLocalApiKey,
  trustEndpoint,
} from "../../src/config/config";
import { EventraConfig } from "../../src/types";

describe("normalizeConfig", () => {
  it("fills defaults for an empty input", () => {
    const out = normalizeConfig({});
    expect(out.apiKey).toBe("");
    expect(out.endpoint).toBe("");
    expect(out.events).toEqual([]);
    expect(out.functionWrappers).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.sync.include).toEqual(["**/*.{ts,tsx,js,jsx}"]);
    expect(out.sync.exclude).toEqual(["node_modules", "dist", ".next", ".git"]);
  });

  it("sorts events alphabetically", () => {
    const out = normalizeConfig({
      events: ["c", "a", "b"],
    });
    expect(out.events).toEqual(["a", "b", "c"]);
  });

  it("dedupes function wrappers by name and drops empty entries", () => {
    const out = normalizeConfig({
      functionWrappers: [
        { name: "trackFeature" },
        { name: "" },
        { name: "trackFeature" },
        { name: "anotherWrapper" },
      ],
    });
    expect(out.functionWrappers.map((w) => w.name)).toEqual([
      "anotherWrapper",
      "trackFeature",
    ]);
  });

  it("strips extra fields from wrappers and keeps only { name }", () => {
    const out = normalizeConfig({
      functionWrappers: [
        // @ts-expect-error — testing extra fields
        { name: "trackFeature", legacy: true, file: "/path/old.ts" },
      ],
    });
    expect(Object.keys(out.functionWrappers[0])).toEqual(["name"]);
  });

  it("preserves provided apiKey, endpoint, include, and exclude", () => {
    const out = normalizeConfig({
      apiKey: "k",
      endpoint: "https://api.example.com",
      sync: {
        include: ["src/**/*.ts"],
        exclude: ["build"],
      },
    });
    expect(out.apiKey).toBe("k");
    expect(out.endpoint).toBe("https://api.example.com");
    expect(out.sync.include).toEqual(["src/**/*.ts"]);
    expect(out.sync.exclude).toEqual(["build"]);
  });
});

describe("resolveApiKey / saveLocalApiKey", () => {
  const originalCwd = process.cwd();
  const originalEnvKey = process.env.EVENTRA_API_KEY;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-config-"));
    process.chdir(tmp);
    delete process.env.EVENTRA_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    if (originalEnvKey === undefined) {
      delete process.env.EVENTRA_API_KEY;
    } else {
      process.env.EVENTRA_API_KEY = originalEnvKey;
    }
  });

  function baseConfig(apiKey = ""): EventraConfig {
    return { ...normalizeConfig({}), apiKey };
  }

  it("falls back to undefined when no key is configured anywhere", async () => {
    expect(await resolveApiKey(baseConfig())).toBeUndefined();
  });

  it("uses the legacy inline apiKey as a last resort", async () => {
    expect(await resolveApiKey(baseConfig("inline-key"))).toBe("inline-key");
  });

  it("prefers eventra.local.json over the legacy inline apiKey", async () => {
    await saveLocalApiKey("local-key");
    expect(await resolveApiKey(baseConfig("inline-key"))).toBe("local-key");
  });

  it("prefers EVENTRA_API_KEY over eventra.local.json and the inline apiKey", async () => {
    await saveLocalApiKey("local-key");
    process.env.EVENTRA_API_KEY = "env-key";
    expect(await resolveApiKey(baseConfig("inline-key"))).toBe("env-key");
  });

  it("writes the key to eventra.local.json and gitignores it", async () => {
    await saveLocalApiKey("local-key");

    const written = await fs.readJSON(path.join(tmp, LOCAL_CONFIG_NAME));
    expect(written).toEqual({ apiKey: "local-key" });

    const gitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(LOCAL_CONFIG_NAME);
  });

  it("appends to an existing .gitignore without duplicating the entry", async () => {
    await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules\n");

    await saveLocalApiKey("local-key");
    await saveLocalApiKey("local-key-2");

    const gitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).filter(Boolean);
    expect(lines.filter((l) => l === LOCAL_CONFIG_NAME)).toHaveLength(1);
    expect(lines).toContain("node_modules");
  });

  it("inserts a leading newline when appending to a .gitignore that doesn't end with one", async () => {
    await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules");

    await saveLocalApiKey("local-key");

    const gitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toBe(`node_modules\n${LOCAL_CONFIG_NAME}\n`);
  });

  it("readLocalSecrets falls back to {} when eventra.local.json is malformed", async () => {
    await fs.writeFile(path.join(tmp, LOCAL_CONFIG_NAME), "{ not valid json");

    expect(await resolveApiKey(baseConfig("inline-key"))).toBe("inline-key");
    expect(await getTrustedEndpoint()).toBeUndefined();
  });

  it("getTrustedEndpoint / trustEndpoint round-trip through eventra.local.json", async () => {
    expect(await getTrustedEndpoint()).toBeUndefined();

    await trustEndpoint("https://ingest.example.com/api/v1/cli/events");
    expect(await getTrustedEndpoint()).toBe("https://ingest.example.com/api/v1/cli/events");
  });
});

describe("loadConfig", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-config-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  it("returns null when eventra.json doesn't exist", async () => {
    expect(await loadConfig()).toBeNull();
  });

  it("returns null when eventra.json contains malformed JSON", async () => {
    await fs.writeFile(path.join(tmp, CONFIG_NAME), "{ not valid json");
    expect(await loadConfig()).toBeNull();
  });

  it("loads and normalizes a well-formed eventra.json", async () => {
    await fs.writeJSON(path.join(tmp, CONFIG_NAME), {
      apiKey: "k",
      events: ["b", "a"],
    });

    const config = await loadConfig();
    expect(config?.apiKey).toBe("k");
    expect(config?.events).toEqual(["a", "b"]);
  });
});
