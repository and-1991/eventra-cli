import fs from "fs-extra";
import os from "os";
import path from "path";
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
  });

  it("blocks an unapproved custom endpoint from eventra.json instead of sending", async () => {
    await setEndpoint(CUSTOM_ENDPOINT);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("not locally approved");
    expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);
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
  });

  it("does not require approval for an endpoint supplied via EVENTRA_ENDPOINT", async () => {
    process.env.EVENTRA_ENDPOINT = CUSTOM_ENDPOINT;

    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CUSTOM_ENDPOINT);
    expect(await fs.pathExists(path.join(tmp, LOCAL_CONFIG_NAME))).toBe(false);
  });
});
