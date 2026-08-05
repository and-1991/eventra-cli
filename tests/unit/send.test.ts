import fs from "fs-extra";
import os from "os";
import path from "path";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_NAME, LOCAL_CONFIG_NAME, normalizeConfig, saveConfig } from "../../src/config/config";
import { send } from "../../src/cli/send";

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
