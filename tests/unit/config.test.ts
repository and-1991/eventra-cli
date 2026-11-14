import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_NAME,
  INIT_EXCLUDE,
  LOCAL_CONFIG_NAME,
  describeConfigProblem,
  getTrustedEndpoint,
  loadConfig,
  normalizeConfig,
  requireConfig,
  resolveApiKey,
  saveConfig,
  saveLocalApiKey,
  trustEndpoint,
  eventraConfigDir,
  getLegacyTrustedEndpoint,
  warnInlineApiKey,
} from "../../src/config/config";
import { EventraConfig } from "../../src/types";

describe("normalizeConfig: dynamicEvents", () => {
  it("keeps the usable declared names, trimmed, once each and sorted, and drops the rest", () => {
    const out = normalizeConfig({ dynamicEvents: ["b.event", " a.event ", "b.event", "", "\t", 7 as unknown as string, "z".repeat(70)] });
    expect(out.dynamicEvents).toEqual(["a.event", "b.event", "z".repeat(64)]);
  });

  it("leaves the key out when nothing usable is declared", () => {
    expect(normalizeConfig({}).dynamicEvents).toBeUndefined();
    expect(normalizeConfig({ dynamicEvents: [] }).dynamicEvents).toBeUndefined();
    expect(normalizeConfig({ dynamicEvents: "x" as unknown as string[] }).dynamicEvents).toBeUndefined();
  });
});

describe("normalizeConfig", () => {
  it("fills defaults for an empty input", () => {
    const out = normalizeConfig({});
    expect(out.apiKey).toBe("");
    expect(out.endpoint).toBe("");
    expect(out.events).toEqual([]);
    expect(out.functionWrappers).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.sync.include).toEqual(["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"]);
    // unchanged: a config without `sync.exclude` must scan what it always scanned
    expect(out.sync.exclude).toEqual(["node_modules", "dist", ".next", ".git"]);
  });

  it("gives a new eventra.json (init) the default plus coverage and test files, but not build or out", () => {
    expect(INIT_EXCLUDE).toEqual([
      "node_modules",
      "dist",
      ".next",
      ".git",
      "coverage",
      ".svelte-kit",
      ".astro",
      ".angular",
      "**/*.{test,spec}.{ts,tsx,js,jsx}",
      "**/__tests__/**",
      "**/__mocks__/**",
    ]);
  });

  it("warns when sync.include or sync.exclude is neither a list nor text, and uses the defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = normalizeConfig({ sync: { include: 5 as unknown as string[], exclude: { a: 1 } as unknown as string[] } });
      const text = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(text).toContain('"sync.include" in eventra.json must be a list of patterns');
      expect(text).toContain('"sync.exclude" in eventra.json must be a list of patterns');
      expect(out.sync.include.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps an event name written twice once", () => {
    expect(normalizeConfig({ events: ["b", "a", "b", "a"] }).events).toEqual(["a", "b"]);
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

  it("treats a key of only spaces as no key, in every source", async () => {
    process.env.EVENTRA_API_KEY = "   \n";
    expect(await resolveApiKey(baseConfig())).toBeUndefined();
    expect(await resolveApiKey(baseConfig("  "))).toBeUndefined();
    // a blank variable does not hide the next source
    await saveLocalApiKey("local-key");
    expect(await resolveApiKey(baseConfig("inline-key"))).toBe("local-key");
  });

  it("returns a key without the spaces around it", async () => {
    process.env.EVENTRA_API_KEY = "  env-key \n";
    expect(await resolveApiKey(baseConfig())).toBe("env-key");
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

  it.skipIf(process.platform === "win32")("creates the key file readable by its owner only, and tightens one written with a wider mode", async () => {
    await saveLocalApiKey("local-key");
    expect((await fs.stat(path.join(tmp, LOCAL_CONFIG_NAME))).mode & 0o777).toBe(0o600);
    await fs.chmod(path.join(tmp, LOCAL_CONFIG_NAME), 0o664);
    await saveLocalApiKey("another-key");
    expect((await fs.stat(path.join(tmp, LOCAL_CONFIG_NAME))).mode & 0o777).toBe(0o600);
  });

  it("says when eventra.local.json is not valid JSON, and carries on without it", async () => {
    await fs.writeFile(path.join(tmp, LOCAL_CONFIG_NAME), "{ half written");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await resolveApiKey(normalizeConfig({}))).toBeUndefined();
      expect(String(warn.mock.calls[0][0])).toContain(`${LOCAL_CONFIG_NAME} is not valid JSON`);
    } finally {
      warn.mockRestore();
    }
  });

  it("still saves the key when the file system refuses to change the mode", async () => {
    const chmod = vi.spyOn(fs, "chmod").mockRejectedValue(new Error("EPERM") as never);
    try {
      await saveLocalApiKey("local-key");
      expect((await fs.readJSON(path.join(tmp, LOCAL_CONFIG_NAME))).apiKey).toBe("local-key");
    } finally {
      chmod.mockRestore();
    }
  });

  it("does not add a second line when .gitignore already ignores the file with a leading slash or a glob", async () => {
    for (const existing of [`/${LOCAL_CONFIG_NAME}\n`, `**/${LOCAL_CONFIG_NAME}\n`]) {
      await fs.writeFile(path.join(tmp, ".gitignore"), existing);
      await saveLocalApiKey("local-key");
      expect(await fs.readFile(path.join(tmp, ".gitignore"), "utf8")).toBe(existing);
    }
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

  it("getTrustedEndpoint / trustEndpoint round-trip through the per-user folder, per project", async () => {
    expect(await getTrustedEndpoint()).toBeUndefined();

    await trustEndpoint("https://ingest.example.com/api/v1/cli/events");
    expect(await getTrustedEndpoint()).toBe("https://ingest.example.com/api/v1/cli/events");
    expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);

    const store = await fs.readJSON(path.join(eventraConfigDir(), "trusted-endpoints.json"));
    expect(store[await fs.realpath(tmp)]).toBe("https://ingest.example.com/api/v1/cli/events");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(eventraConfigDir(), "trusted-endpoints.json"))).mode & 0o777).toBe(0o600);
    }

    // another project has no approval
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-config-other-"));
    process.chdir(other);
    try {
      expect(await getTrustedEndpoint()).toBeUndefined();
    } finally {
      process.chdir(tmp);
      fs.removeSync(other);
    }
  });

  it("never reads an approval from eventra.local.json", async () => {
    await fs.writeJSON(path.join(tmp, LOCAL_CONFIG_NAME), { trustedEndpoint: "https://evil.example.com" });

    expect(await getTrustedEndpoint()).toBeUndefined();
    expect(await getLegacyTrustedEndpoint()).toBe("https://evil.example.com");
  });

  it("drops an old trustedEndpoint from eventra.local.json when the key is saved", async () => {
    await fs.writeJSON(path.join(tmp, LOCAL_CONFIG_NAME), { trustedEndpoint: "https://x.example.com" });
    await saveLocalApiKey("k");

    expect(await fs.readJSON(path.join(tmp, LOCAL_CONFIG_NAME))).toEqual({ apiKey: "k" });
  });

  it("treats a damaged approvals file as no approval", async () => {
    const file = path.join(eventraConfigDir(), "trusted-endpoints.json");
    await fs.mkdirp(eventraConfigDir());
    for (const content of ["{ not json", "[1]", "null", JSON.stringify({ [await fs.realpath(tmp)]: 5 })]) {
      await fs.writeFile(file, content);
      expect(await getTrustedEndpoint()).toBeUndefined();
    }
    await fs.remove(file);
  });

  it("keys a project by its path when the real path cannot be read", async () => {
    const realpath = vi.spyOn(fs, "realpath").mockRejectedValue(new Error("gone") as never);
    try {
      await trustEndpoint("https://ingest.example.com/a");
      expect(await getTrustedEndpoint()).toBe("https://ingest.example.com/a");
    } finally {
      realpath.mockRestore();
    }
  });

  it("refuses to write eventra.local.json through a symbolic link", async () => {
    // C2 of the 2026-11-10 audit: a repo commits eventra.local.json -> some other file
    const victim = path.join(tmp, "victim.txt");
    await fs.writeFile(victim, "keep me");
    await fs.symlink(victim, path.join(tmp, LOCAL_CONFIG_NAME));

    await expect(saveLocalApiKey("secret")).rejects.toThrow("is a symbolic link");
    expect(await fs.readFile(victim, "utf8")).toBe("keep me");
    expect((await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to write eventra.local.json when it is not a regular file", async () => {
    await fs.mkdir(path.join(tmp, LOCAL_CONFIG_NAME));

    await expect(saveLocalApiKey("secret")).rejects.toThrow("is not a regular file");
  });

  it("removes its temporary file when the write fails", async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("disk full") as never);
    try {
      await expect(saveLocalApiKey("secret")).rejects.toThrow("disk full");
    } finally {
      rename.mockRestore();
    }
    expect((await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("finds the approvals folder from the environment, else the home folder", () => {
    const saved = { ...process.env };
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      process.env.EVENTRA_CONFIG_DIR = "/custom";
      expect(eventraConfigDir()).toBe("/custom");

      delete process.env.EVENTRA_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = "/xdg";
      expect(eventraConfigDir()).toBe(path.join("/xdg", "eventra"));

      delete process.env.XDG_CONFIG_HOME;
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.APPDATA = "C:/AppData";
      expect(eventraConfigDir()).toBe(path.join("C:/AppData", "eventra"));

      delete process.env.APPDATA;
      expect(eventraConfigDir()).toBe(path.join(os.homedir(), ".config", "eventra"));
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.env = saved;
    }
  });
});

describe("config problems and saving", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-config-problem-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.removeSync(tmp);
  });

  it("describes a missing file and a malformed file differently", async () => {
    expect(await describeConfigProblem()).toBe("eventra.json not found");

    await fs.writeFile(path.join(tmp, CONFIG_NAME), "{ not valid json");
    expect(await describeConfigProblem()).toMatch(/^eventra\.json is not valid JSON: /);
  });

  it("falls back to a generic message when the file parses but cannot be loaded", async () => {
    await fs.writeJSON(path.join(tmp, CONFIG_NAME), { ok: true });
    expect(await describeConfigProblem()).toBe("eventra.json could not be read");
  });

  it("requireConfig returns the config without touching the exit code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.writeJSON(path.join(tmp, CONFIG_NAME), { apiKey: "k" });
    expect((await requireConfig())?.apiKey).toBe("k");
    expect(process.exitCode).toBeUndefined();
  });

  it("requireConfig warns about an inline apiKey without printing it, and stays quiet for an empty one", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await fs.writeJSON(path.join(tmp, CONFIG_NAME), { apiKey: "" });
    await requireConfig();
    expect(err).not.toHaveBeenCalled();

    await fs.writeJSON(path.join(tmp, CONFIG_NAME), { apiKey: "secret-key-123" });
    await requireConfig();
    expect(err).toHaveBeenCalledTimes(1);
    const message = String(err.mock.calls[0]?.[0]);
    expect(message).toContain("EVENTRA_API_KEY");
    expect(message).toContain(LOCAL_CONFIG_NAME);
    expect(message).not.toContain("secret-key-123");
  });

  it("warnInlineApiKey does nothing when the field is empty", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    warnInlineApiKey(normalizeConfig({}));
    expect(err).not.toHaveBeenCalled();
  });

  it("requireConfig reports the reason and sets exit code 1 for a missing or malformed file", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await requireConfig()).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenLastCalledWith("eventra.json not found");

    process.exitCode = undefined;
    await fs.writeFile(path.join(tmp, CONFIG_NAME), "nope");
    expect(await requireConfig()).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("not valid JSON");
  });

  it("saveConfig leaves the file alone when nothing changed", async () => {
    await saveConfig(normalizeConfig({ events: ["a"] }));
    const file = path.join(tmp, CONFIG_NAME);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);

    await saveConfig(normalizeConfig({ events: ["a"] }));
    expect(fs.statSync(file).mtimeMs).toBeCloseTo(old.getTime(), -2);

    await saveConfig(normalizeConfig({ events: ["a", "b"] }));
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    expect(fs.readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
  });

  it("orders function wrappers by plain comparison, independent of the locale", () => {
    const out = normalizeConfig({
      functionWrappers: [{ name: "b" }, { name: "B" }, { name: "a" }, { name: "b" }],
    });
    expect(out.functionWrappers.map((w) => w.name)).toEqual(["B", "a", "b"]);
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

describe("normalizeConfig: what a rewrite must not destroy", () => {
  it("keeps keys the CLI does not know, at the top and inside sync", () => {
    const out = normalizeConfig({ $schema: "https://example.com/s.json", team: "growth", sync: { include: ["src/**/*.ts"], exclude: [], note: "mine" } } as never) as unknown as Record<string, unknown>;
    expect(out.$schema).toBe("https://example.com/s.json");
    expect(out.team).toBe("growth");
    expect((out.sync as Record<string, unknown>).note).toBe("mine");
  });

  it("reads a lone string as a list of one for plugins, include and exclude", () => {
    const out = normalizeConfig({ plugins: "@eventra_dev/cli-plugin-vue", sync: { include: "src/**/*.ts", exclude: "dist" } } as never);
    expect(out.plugins).toEqual(["@eventra_dev/cli-plugin-vue"]);
    expect(out.sync.include).toEqual(["src/**/*.ts"]);
    expect(out.sync.exclude).toEqual(["dist"]);
  });

  it("drops non-strings and repeats from plugins", () => {
    const out = normalizeConfig({ plugins: ["@eventra_dev/cli-plugin-vue", " @eventra_dev/cli-plugin-vue ", 5, null, ""] } as never);
    expect(out.plugins).toEqual(["@eventra_dev/cli-plugin-vue"]);
  });

  it("says once that a plugin entry that is not a string is dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeConfig({ plugins: [{ only: "this-test" }, "@eventra_dev/cli-plugin-vue"] } as never);
      normalizeConfig({ plugins: [{ only: "this-test" }] } as never);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("a package name");
    } finally {
      warn.mockRestore();
    }
  });

  it("reads Windows-style separators in globs as /", () => {
    const out = normalizeConfig({ sync: { include: ["src\\**\\*.ts", "app\\(group)\\*.ts"], exclude: ["dist\\out"] } });
    expect(out.sync.include).toEqual(["src/**/*.ts", "app/(group)/*.ts"]);
    expect(out.sync.exclude).toEqual(["dist/out"]);
  });
});

describe("loadConfig: a file that is not an object", () => {
  let tmp: string;
  const original = process.cwd();
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-cfg-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(original);
    fs.removeSync(tmp);
  });

  it("returns null for a list, so it is not overwritten with defaults, and says what is wrong", async () => {
    fs.writeFileSync(path.join(tmp, CONFIG_NAME), "[]");
    expect(await loadConfig()).toBeNull();
    expect(await describeConfigProblem()).toMatch(/must contain a JSON object.*a list/);
    fs.writeFileSync(path.join(tmp, CONFIG_NAME), "null");
    expect(await describeConfigProblem()).toMatch(/not null/);
    fs.writeFileSync(path.join(tmp, CONFIG_NAME), "5");
    expect(await describeConfigProblem()).toMatch(/not a number/);
  });
});
