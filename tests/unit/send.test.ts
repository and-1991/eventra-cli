import fs from "fs-extra";
import os from "os";
import path from "path";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_NAME, LOCAL_CONFIG_NAME, normalizeConfig, saveConfig } from "../../src/config/config";
import { isRedirectError, send } from "../../src/cli/send";

const CUSTOM_ENDPOINT = "https://ingest.self-hosted.example.com/api/v1/cli/events";
const DEFAULT_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";

describe("send() — endpoint trust-on-first-use", () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let tmp: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-send-"));
    process.chdir(tmp);
    process.env.EVENTRA_API_KEY = "test-key";
    delete process.env.EVENTRA_ENDPOINT;
    process.exitCode = 0;

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ created: ["a"], existing: [] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await saveConfig(normalizeConfig({ events: ["a"] }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function setEndpoint(endpoint: string) {
    const config = await fs.readJSON(path.join(tmp, CONFIG_NAME));
    config.endpoint = endpoint;
    await fs.writeJSON(path.join(tmp, CONFIG_NAME), config);
  }

  it("sends immediately when eventra.json has the default endpoint (always trusted, no approval needed)", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DEFAULT_ENDPOINT);
    expect(process.exitCode).toBe(0);
  });

  it("warns about an apiKey inside eventra.json, still sends, and does not print the key", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await saveConfig(normalizeConfig({ events: ["a"], apiKey: "inline-secret", endpoint: DEFAULT_ENDPOINT }));
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).not.toContain("inline-secret");
  });

  it("blocks an unapproved custom endpoint from eventra.json instead of sending, and fails the process", async () => {
    await setEndpoint(CUSTOM_ENDPOINT);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("not locally approved");
    expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("approves and sends with --trust-endpoint, then sends without it on the next run", async () => {
    await setEndpoint(CUSTOM_ENDPOINT);

    await send({ trustEndpoint: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CUSTOM_ENDPOINT);

    const local = await fs.readJSON(path.join(tmp, LOCAL_CONFIG_NAME));
    expect(local.trustedEndpoint).toBe(CUSTOM_ENDPOINT);

    // gitignored, so it can never end up committed alongside eventra.json
    const gitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toContain(LOCAL_CONFIG_NAME);

    fetchMock.mockClear();
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CUSTOM_ENDPOINT);
    expect(process.exitCode).toBe(0);
  });

  it("re-blocks when eventra.json's endpoint changes again after being trusted", async () => {
    await setEndpoint(CUSTOM_ENDPOINT);
    await send({ trustEndpoint: true });
    fetchMock.mockClear();

    await setEndpoint("https://attacker.example.com/api/v1/cli/events");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("not locally approved");
    expect(process.exitCode).toBe(1);
  });

  it("uses EVENTRA_ENDPOINT over eventra.json, so a committed endpoint cannot redirect a CI send", async () => {
    // the attack: CI sets EVENTRA_ENDPOINT, a PR edits eventra.json to point elsewhere
    process.env.EVENTRA_ENDPOINT = CUSTOM_ENDPOINT;
    await setEndpoint("https://evil.example.com/api/v1/cli/events");

    await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CUSTOM_ENDPOINT);
    expect(process.exitCode).toBe(0);
  });

  it("still requires approval for eventra.json's endpoint when EVENTRA_ENDPOINT is set to an empty string", async () => {
    process.env.EVENTRA_ENDPOINT = "";
    await setEndpoint("https://evil.example.com/api/v1/cli/events");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sends to a plain http endpoint on a remote host, but warns that the key is unencrypted", async () => {
    process.env.EVENTRA_ENDPOINT = "http://host.docker.internal:4000/cli/events";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://host.docker.internal:4000/cli/events");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("plain http");
    expect(process.exitCode).toBe(0);
  });

  it("refuses an endpoint that is not a URL", async () => {
    process.env.EVENTRA_ENDPOINT = "not a url";
    vi.spyOn(console, "log").mockImplementation(() => {});

    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(["http://localhost:4000/cli/events", "http://127.0.0.1:4000/cli/events", "http://[::1]:4000/cli/events"])(
    "sends to the local ingest server %s without any warning",
    async (endpoint) => {
      process.env.EVENTRA_ENDPOINT = endpoint;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await send();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls.flat().join("\n")).not.toContain("plain http");
      expect(process.exitCode).toBe(0);
    },
  );

  it("refuses an endpoint that is not http or https", async () => {
    process.env.EVENTRA_ENDPOINT = "file:///etc/passwd";
    vi.spyOn(console, "log").mockImplementation(() => {});

    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not follow redirects, so the API key cannot be forwarded to another host", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);

    await send();

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("asks for a typed API key as a password, not as visible text", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    delete process.env.EVENTRA_API_KEY;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const promptSpy = vi.spyOn(inquirer, "prompt").mockResolvedValue({ apiKey: "k" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await send();
      const questions = promptSpy.mock.calls[0]?.[0] as unknown as Array<{ type: string }>;
      expect(questions[0]?.type).toBe("password");
    } finally {
      if (isTTYDescriptor) Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("does not require approval for an endpoint supplied via EVENTRA_ENDPOINT", async () => {
    process.env.EVENTRA_ENDPOINT = CUSTOM_ENDPOINT;

    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CUSTOM_ENDPOINT);
    expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it("fails the process when no API key can be resolved in a non-interactive shell", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    delete process.env.EVENTRA_API_KEY;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("API key required");
    expect(process.exitCode).toBe(1);
  });

  it("fails the process once retries are exhausted on a non-Error rejection, with no extra detail line", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockRejectedValue("not an Error instance");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("All retries exhausted");
    expect(output).not.toContain("Last status:");
    expect(output).not.toContain("not an Error instance");
    expect(process.exitCode).toBe(1);
  }, 20_000);

  it("fails the process when no endpoint is configured and EVENTRA_ENDPOINT isn't set", async () => {
    // No setEndpoint() call - eventra.json's `endpoint` defaults to "" (falsy),
    // and EVENTRA_ENDPOINT is deleted in beforeEach, so `endpoint` resolves to
    // undefined by the time the events/apiKey checks pass.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Endpoint not configured");
    expect(process.exitCode).toBe(1);
  });

  it("fails the process when there are no events to send", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    await saveConfig(normalizeConfig({ events: [] }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("No events found");
    expect(process.exitCode).toBe(1);
  });

  it("fails the process on a definitive non-retryable failure (e.g. 401)", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Request failed (401)");
    expect(process.exitCode).toBe(1);
  });

  it("fails the process once retries are exhausted on a retryable failure (e.g. 500)", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("All retries exhausted");
    expect(process.exitCode).toBe(1);
  }, 20_000);

  it("fails the process when eventra.json doesn't exist", async () => {
    await fs.remove(path.join(tmp, CONFIG_NAME));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("eventra.json not found");
    expect(process.exitCode).toBe(1);
  });

  it("prompts interactively for an API key on a TTY when none can be resolved, and saves it", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    delete process.env.EVENTRA_API_KEY;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const promptSpy = vi.spyOn(inquirer, "prompt").mockResolvedValue({ apiKey: "prompted-key" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await send();

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.headers?.["x-api-key"]).toBe("prompted-key");
      expect(logSpy.mock.calls.flat().join("\n")).toContain("API key saved to eventra.local.json");
      const local = await fs.readJSON(path.join(tmp, LOCAL_CONFIG_NAME));
      expect(local.apiKey).toBe("prompted-key");
      expect(process.exitCode).toBe(0);
    } finally {
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      }
    }
  });

  it("does not persist a key when the interactive prompt is left empty, and then fails on the missing-key check", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    delete process.env.EVENTRA_API_KEY;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const promptSpy = vi.spyOn(inquirer, "prompt").mockResolvedValue({ apiKey: "" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await send();

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);
      expect(logSpy.mock.calls.flat().join("\n")).toContain("API key required");
      expect(process.exitCode).toBe(1);
    } finally {
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      }
    }
  });

  it("fails the process on a definitive non-retryable failure with no response body (e.g. 403)", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Request failed (403)");
    expect(process.exitCode).toBe(1);
  });

  it("explains a redirect and stops at once instead of retrying it", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = new Error("unexpected redirect");
    fetchMock.mockRejectedValue(err);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("answered with a redirect");
    expect(output).toContain("Use the final URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("tells a redirect apart from an ordinary network error", () => {
    const withCause = (message: string) => Object.assign(new TypeError("fetch failed"), { cause: new Error(message) });

    expect(isRedirectError(withCause("unexpected redirect"))).toBe(true);
    expect(isRedirectError(withCause("getaddrinfo ENOTFOUND api.eventra.dev"))).toBe(false);
    expect(isRedirectError(new Error("network down"))).toBe(false);
    expect(isRedirectError(null)).toBe(false);
    expect(isRedirectError("redirect")).toBe(false);
  });

  it("explains a refused SDK key and how to get a CLI key", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"API key is not valid for this endpoint"}',
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Request failed (403)");
    expect(output).toContain("created for the SDK");
    expect(output).toContain("CLI access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("gives no key hint for a 403 that is about something else", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("created for the SDK");
  });

  it("fails the process once retries are exhausted on a retryable failure with no response body", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("All retries exhausted");
    expect(output).toContain("Last status: 500");
    expect(process.exitCode).toBe(1);
  }, 20_000);

  it("fails the process once retries are exhausted on repeated network errors (fetch throws)", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockRejectedValue(new Error("network down"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Attempt 1/4 failed (network error)");
    expect(output).toContain("All retries exhausted");
    expect(output).toContain("network down");
    expect(process.exitCode).toBe(1);
  }, 20_000);

  it("reports created and existing events separately on success", async () => {
    await setEndpoint(DEFAULT_ENDPOINT);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ created: [], existing: ["a"] }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Existing events:");
    expect(output).not.toContain("New events:");
    expect(output).not.toContain("queued for processing");
    expect(process.exitCode).toBe(0);
  });
});

describe("send() - catalog fields", () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let tmp: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const ok = { ok: true, status: 200, json: async () => ({ created: [], existing: ["a"] }) };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-send-cat-"));
    process.chdir(tmp);
    process.env.EVENTRA_API_KEY = "test-key";
    process.env.GITHUB_REF_NAME = "main";
    process.env.EVENTRA_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";
    process.exitCode = 0;
    fetchMock = vi.fn().mockResolvedValue(ok);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await saveConfig(normalizeConfig({ events: ["a"] }));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call]?.[1].body as string);

  it("posts complete, cliVersion, dynamicCount and branch next to the unchanged events and cli fields", async () => {
    await send();
    const body = sentBody();
    expect(body.events).toEqual(["a"]);
    expect(body.cli).toMatchObject({ name: "@eventra_dev/eventra-cli", runtime: "node" });
    // the temp project has no source, so the scan finds nothing and the list is stale
    expect(body.complete).toBe(false);
    expect(body.dynamicCount).toBe(0);
    expect(body.branch).toBe("main");
    expect(body.cliVersion).toBe(body.cli.version);
  });

  it("says the snapshot is incomplete when the list is out of date", async () => {
    await send();
    const printed = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(printed).toContain("Catalog snapshot marked incomplete");
  });

  it("sends complete: true when the scan is clean and matches eventra.json", async () => {
    await fs.writeFile(
      path.join(tmp, "app.ts"),
      'import { Eventra } from "@eventra_dev/eventra-sdk";\nconst sdk = new Eventra({ apiKey: "k" });\nsdk.track("a");\n',
    );
    await send();
    const body = sentBody();
    expect(body.events).toEqual(["a"]);
    expect(body.complete).toBe(true);
    expect(body.dynamicCount).toBe(0);
  });

  it("sends complete: false and no dynamicCount when the scan itself fails", async () => {
    // an unreadable tsconfig makes the compiler context throw
    await fs.writeFile(path.join(tmp, "tsconfig.json"), "{ not json");
    await send();
    const body = sentBody();
    expect(body.complete).toBe(false);
    expect(body).not.toHaveProperty("dynamicCount");
    expect(body.events).toEqual(["a"]);
    expect(process.exitCode).toBe(0);
  });

  it("repeats the request without the catalog fields when an older server rejects them", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"code":"VALIDATION_ERROR","message":"Validation failed"}}',
      })
      .mockResolvedValueOnce(ok);

    await send();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0)).toHaveProperty("complete");
    const legacy = sentBody(1);
    expect(legacy).toEqual({ events: ["a"], cli: expect.objectContaining({ runtime: "node" }) });
    expect(process.exitCode).toBe(0);
  });

  it("does not loop when the plain request is rejected too", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"code":"VALIDATION_ERROR"}}',
    });

    await send();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  it("does not retry other 400 responses and keeps the catalog fields", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "nope" });
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("treats a 400 whose body cannot be read as a plain failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => {
        throw new Error("stream closed");
      },
    });
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
