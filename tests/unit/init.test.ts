import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompt = vi.fn();
vi.mock("inquirer", () => ({ default: { prompt: (...args: unknown[]) => prompt(...args) } }));

const saved = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock("../../src/config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config")>();
  return {
    ...actual,
    saveConfig: async (config: Parameters<typeof actual.saveConfig>[0]) => {
      saved.configs.push(config);
      return actual.saveConfig(config);
    },
  };
});

import { init } from "../../src/cli/init";

let cwd: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

function writePackage(content: object, dir = cwd) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(content));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(cwd, "eventra.json"), "utf8"));
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-init-"));
  // Not process.chdir(): that is unavailable in worker threads (Stryker's vitest runner uses them).
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  prompt.mockReset();
  saved.configs.length = 0;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(cwd, { recursive: true, force: true });
  log.mockRestore();
});

const answersFor = (presets?: string[]) => async (questions: Array<{ name: string }>) =>
  questions[0].name === "presets" ? { presets } : { apiKey: "", endpoint: "https://api.eventra.dev/api/v1/cli/events" };

describe("init: analytics detection", () => {
  it("asks about detected analytics with everything pre-selected and writes the chosen presets", async () => {
    writePackage({ dependencies: { "posthog-js": "1", "@segment/analytics-next": "1", react: "19" } });
    prompt.mockImplementation(answersFor(["posthog", "segment"]));
    await init();

    const checkbox = prompt.mock.calls[1][0][0];
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.choices).toEqual([
      { name: "posthog (posthog-js)", value: "posthog", checked: true },
      { name: "segment (@segment/analytics-next)", value: "segment", checked: true },
    ]);
    expect(readConfig().sinks).toEqual([{ preset: "posthog" }, { preset: "segment" }]);
    expect(log.mock.calls.flat().join("\n")).toContain("sinks: posthog, segment");
  });

  it("writes only the presets the user kept", async () => {
    writePackage({ dependencies: { "posthog-js": "1", "react-ga4": "1" } });
    prompt.mockImplementation(answersFor(["ga4"]));
    await init();
    expect(readConfig().sinks).toEqual([{ preset: "ga4" }]);
  });

  it("writes no sinks when the user unticks everything", async () => {
    writePackage({ dependencies: { "posthog-js": "1" } });
    prompt.mockImplementation(answersFor([]));
    await init();
    expect("sinks" in readConfig()).toBe(false);
    expect(log.mock.calls.flat().join("\n")).not.toContain("sinks:");
  });

  it("does not ask anything extra when no analytics is found", async () => {
    writePackage({ dependencies: { react: "19" } });
    prompt.mockImplementation(answersFor(undefined));
    await init();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect("sinks" in readConfig()).toBe(false);
  });

  it("works without a package.json at all", async () => {
    prompt.mockImplementation(answersFor(undefined));
    await init();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(readConfig().events).toEqual([]);
  });

  it("finds analytics declared in a workspace member", async () => {
    writePackage({ workspaces: ["apps/*"] });
    writePackage({ dependencies: { "@amplitude/analytics-browser": "2" } }, path.join(cwd, "apps/web"));
    prompt.mockImplementation(answersFor(["amplitude"]));
    await init();
    expect(readConfig().sinks).toEqual([{ preset: "amplitude" }]);
  });

  it("still keeps the API key out of eventra.json", async () => {
    prompt.mockImplementation(async (questions: Array<{ name: string }>) =>
      questions[0].name === "presets" ? { presets: [] } : { apiKey: "secret-key", endpoint: "https://api.eventra.dev/api/v1/cli/events" },
    );
    await init();
    expect(JSON.stringify(readConfig())).not.toContain("secret-key");
    expect(JSON.parse(fs.readFileSync(path.join(cwd, "eventra.local.json"), "utf8")).apiKey).toBe("secret-key");
  });
});

const output = () => log.mock.calls.flat().join("\n");

describe("init: prompts, defaults and output", () => {
  it("asks for an API key and an endpoint, with the production endpoint as the default", async () => {
    prompt.mockImplementation(answersFor(undefined));
    await init();
    expect(prompt.mock.calls[0][0]).toEqual([
      { type: "input", name: "apiKey", message: "API Key (optional):" },
      { type: "input", name: "endpoint", message: "Custom endpoint (optional):", default: "https://api.eventra.dev/api/v1/cli/events" },
    ]);
  });

  it("writes the documented defaults, uses the chosen endpoint and never puts a key in the committed config", async () => {
    prompt.mockImplementation(async () => ({ apiKey: "", endpoint: "https://eventra.example.com/cli" }));
    await init();
    expect(readConfig()).toEqual({
      apiKey: "",
      endpoint: "https://eventra.example.com/cli",
      events: [],
      functionWrappers: [],
      plugins: [],
      sync: {
        include: ["**/*.{ts,tsx,js,jsx}"],
        exclude: ["node_modules", "dist", ".next", ".git"],
      },
    });
  });

  it("hands saveConfig a config without a sinks key when nothing was chosen", async () => {
    writePackage({ dependencies: { "posthog-js": "1" } });
    prompt.mockImplementation(answersFor([]));
    await init();
    expect(saved.configs).toHaveLength(1);
    expect("sinks" in (saved.configs[0] as object)).toBe(false);
  });

  it("hands saveConfig the sinks that were chosen", async () => {
    writePackage({ dependencies: { "posthog-js": "1" } });
    prompt.mockImplementation(answersFor(["posthog"]));
    await init();
    expect((saved.configs[0] as { sinks: unknown }).sinks).toEqual([{ preset: "posthog" }]);
  });

  it("prints the intro, what was found and the next step", async () => {
    writePackage({ dependencies: { "posthog-js": "1", "posthog-node": "5", "react-ga4": "3" } });
    prompt.mockImplementation(answersFor(["posthog"]));
    await init();
    const text = output();
    expect(text).toContain("Initializing Eventra...");
    expect(text).toContain("Found analytics in package.json: posthog-js, posthog-node; react-ga4");
    expect(text).toContain("Eventra detects @eventra_dev/eventra-sdk usage:");
    expect(text).toContain('• tracker.track("event.name")');
    expect(text).toContain("• function wrappers → Eventra.track()");
    expect(text).toContain("• cross-file propagation chains");
    expect(text).toContain("eventra.json created");
    expect(text).toContain("sinks: posthog");
    expect(text).toContain("Run `eventra sync`");
  });

  it("words the checkbox choices and question", async () => {
    writePackage({ dependencies: { "posthog-js": "1", "posthog-node": "5" } });
    prompt.mockImplementation(answersFor(["posthog"]));
    await init();
    const [question] = prompt.mock.calls[1][0];
    expect(question).toMatchObject({
      type: "checkbox",
      name: "presets",
      message: "Also read events from these analytics calls (sinks):",
    });
    expect(question.choices[0].name).toBe("posthog (posthog-js, posthog-node)");
  });

  it("saves a typed API key to the gitignored local file and says so", async () => {
    prompt.mockImplementation(async () => ({ apiKey: "k-123", endpoint: "https://api.eventra.dev/api/v1/cli/events" }));
    await init();
    expect(JSON.parse(fs.readFileSync(path.join(cwd, "eventra.local.json"), "utf8")).apiKey).toBe("k-123");
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain("eventra.local.json");
    expect(output()).toContain("API key saved to eventra.local.json (added to .gitignore)");
  });

  it("writes no local file and prints nothing about a key when none was typed", async () => {
    prompt.mockImplementation(answersFor(undefined));
    await init();
    expect(fs.existsSync(path.join(cwd, "eventra.local.json"))).toBe(false);
    expect(output()).not.toContain("API key saved");
  });

  it("hands saveConfig exactly the documented config when no analytics is found", async () => {
    prompt.mockImplementation(async () => ({ apiKey: "", endpoint: "https://eventra.example.com/cli" }));
    await init();
    expect(saved.configs).toEqual([
      {
        apiKey: "",
        endpoint: "https://eventra.example.com/cli",
        events: [],
        functionWrappers: [],
        sync: {
          include: ["**/*.{ts,tsx,js,jsx}"],
          exclude: ["node_modules", "dist", ".next", ".git"],
        },
      },
    ]);
  });

  it("prints its messages in this exact order, blank lines included", async () => {
    prompt.mockImplementation(answersFor(undefined));
    await init();
    // eslint-disable-next-line no-control-regex
    const lines = log.mock.calls.map((call) => String(call[0]).replace(/\u001b\[[0-9;]*m/g, ""));
    expect(lines).toEqual([
      "Initializing Eventra...",
      "",
      "Eventra detects @eventra_dev/eventra-sdk usage:",
      '• tracker.track("event.name")',
      "• function wrappers → Eventra.track()",
      "• cross-file propagation chains",
      "",
      "eventra.json created",
      "",
      "Run `eventra sync`",
    ]);
  });
});

describe("init: existing eventra.json and --yes", () => {
  const existing = { apiKey: "", endpoint: "x", events: ["keep.me"], functionWrappers: [], plugins: ["@eventra_dev/cli-plugin-vue"] };

  it("asks before overwriting and keeps the file on no", async () => {
    fs.writeFileSync(path.join(cwd, "eventra.json"), JSON.stringify(existing));
    prompt.mockResolvedValueOnce({ overwrite: false });
    await init();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(readConfig().events).toEqual(["keep.me"]);
    expect(readConfig().plugins).toEqual(["@eventra_dev/cli-plugin-vue"]);
  });

  it("overwrites only after an explicit yes", async () => {
    fs.writeFileSync(path.join(cwd, "eventra.json"), JSON.stringify(existing));
    prompt.mockImplementation(async (questions: Array<{ name: string }>) =>
      questions[0].name === "overwrite"
        ? { overwrite: true }
        : { apiKey: "", endpoint: "https://api.eventra.dev/api/v1/cli/events" },
    );
    await init();

    expect(readConfig().events).toEqual([]);
    expect(readConfig().plugins).toEqual([]);
  });

  it("--yes never prompts and never overwrites an existing file", async () => {
    fs.writeFileSync(path.join(cwd, "eventra.json"), JSON.stringify(existing));
    await init({ yes: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(readConfig().events).toEqual(["keep.me"]);
  });

  it("--yes creates a config with defaults and every detected preset, without prompting", async () => {
    writePackage({ dependencies: { "posthog-js": "1", react: "19" } });
    await init({ yes: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(readConfig().endpoint).toBe("https://api.eventra.dev/api/v1/cli/events");
    expect(readConfig().sinks).toEqual([{ preset: "posthog" }]);
  });

  it("--yes with nothing detected writes no sinks", async () => {
    writePackage({ dependencies: { react: "19" } });
    await init({ yes: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(readConfig().sinks).toBeUndefined();
  });
});

