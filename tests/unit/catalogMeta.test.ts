import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
const scanProject = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execFileSync }));
vi.mock("../../src/core/projectScanner", () => ({ scanProject }));

import { collectCatalogMeta, countUnresolved, detectBranch, isPullRequestBuild } from "../../src/core/catalogMeta";
import type { EventraConfig } from "../../src/types";

const config = (events: string[]): EventraConfig => ({
  events,
  sync: { include: [], exclude: [] },
});

const occurrence = (resolvedValues: string[]) =>
  ({ resolvedValues }) as unknown as Parameters<typeof countUnresolved>[0][number];

function fakeScan(events: string[], skipped: unknown[] = [], dynamic: string[][] = []) {
  scanProject.mockResolvedValue({
    engine: {
      getAllEvents: () => events,
      getAllDynamicOccurrences: () => dynamic.map(occurrence),
    },
    skipped,
  });
}

describe("detectBranch", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("prefers a CI environment variable over git (detached HEAD in CI)", () => {
    expect(detectBranch({ GITHUB_REF_NAME: "release/1.2" }, "/x")).toBe("release/1.2");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("tries the variables in order and ignores blank ones", () => {
    expect(detectBranch({ GITHUB_REF_NAME: "  ", CI_COMMIT_REF_NAME: "main" }, "/x")).toBe("main");
  });

  it("trims the branch name to 200 characters", () => {
    expect(detectBranch({ BRANCH_NAME: "b".repeat(500) }, "/x")).toHaveLength(200);
  });

  it("falls back to git when no variable is set", () => {
    execFileSync.mockReturnValue("feature/x\n");
    expect(detectBranch({}, "/repo")).toBe("feature/x");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      expect.objectContaining({ cwd: "/repo", timeout: 3000 }),
    );
  });

  it("trims a long git branch name", () => {
    execFileSync.mockReturnValue(`${"c".repeat(300)}\n`);
    expect(detectBranch({}, "/repo")).toHaveLength(200);
  });

  it("treats a detached HEAD as unknown", () => {
    execFileSync.mockReturnValue("HEAD\n");
    expect(detectBranch({}, "/repo")).toBeUndefined();
  });

  it("treats empty git output as unknown", () => {
    execFileSync.mockReturnValue("\n");
    expect(detectBranch({}, "/repo")).toBeUndefined();
  });

  it("never throws when git is missing or this is not a repository", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    expect(detectBranch({}, "/repo")).toBeUndefined();
  });

  it("defaults to the process environment and working directory", () => {
    execFileSync.mockReturnValue("dev\n");
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (/^(GITHUB_REF_NAME|CI_COMMIT_REF_NAME|BRANCH_NAME|BITBUCKET_BRANCH|CIRCLE_BRANCH|BUILDKITE_BRANCH|VERCEL_GIT_COMMIT_REF)$/.test(key)) {
        delete process.env[key];
      }
    }
    try {
      expect(detectBranch()).toBe("dev");
    } finally {
      process.env = saved;
    }
  });
});

describe("countUnresolved", () => {
  it("counts only call sites with no resolved value", () => {
    expect(countUnresolved([occurrence([]), occurrence(["a"]), occurrence([])])).toBe(2);
    expect(countUnresolved([])).toBe(0);
  });

  it("does not count the copy of an Angular component class twice", () => {
    const generated = { resolvedValues: [], inGeneratedCode: true } as unknown as Parameters<typeof countUnresolved>[0][number];
    expect(countUnresolved([occurrence([]), generated])).toBe(1);
  });
});

describe("isPullRequestBuild", () => {
  it.each([
    ["GitHub pull_request event", { GITHUB_EVENT_NAME: "pull_request" }],
    ["GitHub pull_request_target event", { GITHUB_EVENT_NAME: "pull_request_target" }],
    ["GitHub merge ref", { GITHUB_REF: "refs/pull/12/merge" }],
    ["GitLab merge request", { CI_MERGE_REQUEST_IID: "7" }],
    ["GitLab merge request pipeline", { CI_PIPELINE_SOURCE: "merge_request_event" }],
    ["Bitbucket pull request", { BITBUCKET_PR_ID: "3" }],
    ["CircleCI pull request URL", { CIRCLE_PULL_REQUEST: "https://github.com/o/r/pull/1" }],
    ["CircleCI pull request number", { CIRCLE_PR_NUMBER: "1" }],
    ["Buildkite pull request", { BUILDKITE_PULL_REQUEST: "42" }],
    ["Vercel pull request", { VERCEL_GIT_PULL_REQUEST_ID: "9" }],
    ["Travis pull request", { TRAVIS_PULL_REQUEST: "5" }],
    ["Azure pull request id", { SYSTEM_PULLREQUEST_PULLREQUESTID: "8" }],
    ["Azure build reason", { BUILD_REASON: "PullRequest" }],
    ["Jenkins change id", { CHANGE_ID: "17" }],
  ])("detects %s", (_name, env) => {
    expect(isPullRequestBuild(env)).toBe(true);
  });

  it("does not flag ordinary branch builds", () => {
    expect(isPullRequestBuild({})).toBe(false);
    expect(isPullRequestBuild({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" })).toBe(false);
    expect(isPullRequestBuild({ BUILDKITE_PULL_REQUEST: "false" })).toBe(false);
    expect(isPullRequestBuild({ TRAVIS_PULL_REQUEST: "false" })).toBe(false);
    expect(isPullRequestBuild({ CI_PIPELINE_SOURCE: "push" })).toBe(false);
  });

  it("defaults to the process environment", () => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (/PULL|MERGE_REQUEST|CHANGE_ID|BUILD_REASON|GITHUB_REF$|GITHUB_EVENT_NAME|CI_PIPELINE_SOURCE|BITBUCKET_PR_ID|CIRCLE_PR/.test(key)) {
        delete process.env[key];
      }
    }
    try {
      expect(isPullRequestBuild()).toBe(false);
      process.env.CHANGE_ID = "1";
      expect(isPullRequestBuild()).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});

describe("collectCatalogMeta", () => {
  beforeEach(() => {
    scanProject.mockReset();
    execFileSync.mockReset();
    execFileSync.mockReturnValue("main\n");
  });

  afterEach(() => vi.restoreAllMocks());

  it("is complete when nothing was skipped and eventra.json matches the scan", async () => {
    fakeScan(["a", "b"], [], [[], ["x"]]);
    expect(await collectCatalogMeta(config(["b", "a"]))).toEqual({
      complete: true,
      dynamicCount: 1,
      branch: "main",
    });
  });

  it("is incomplete for a pull / merge request build, even when everything else matches", async () => {
    fakeScan(["a"]);
    const saved = process.env.GITHUB_EVENT_NAME;
    process.env.GITHUB_EVENT_NAME = "pull_request";
    try {
      expect((await collectCatalogMeta(config(["a"]))).complete).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_EVENT_NAME;
      else process.env.GITHUB_EVENT_NAME = saved;
    }
  });

  it("is incomplete when a file was skipped", async () => {
    fakeScan(["a"], [{ file: "x", reason: "bad" }]);
    expect((await collectCatalogMeta(config(["a"]))).complete).toBe(false);
  });

  it("is incomplete when eventra.json is out of date (extra, missing or different names)", async () => {
    fakeScan(["a", "b"]);
    expect((await collectCatalogMeta(config(["a"]))).complete).toBe(false);
    fakeScan(["a"]);
    expect((await collectCatalogMeta(config(["a", "b"]))).complete).toBe(false);
    fakeScan(["a", "c"]);
    expect((await collectCatalogMeta(config(["a", "b"]))).complete).toBe(false);
  });

  it("treats a config without events as an empty list", async () => {
    fakeScan([]);
    expect((await collectCatalogMeta({ sync: { include: [], exclude: [] } } as unknown as EventraConfig)).complete).toBe(true);
  });

  it("is incomplete and omits dynamicCount when the scan throws", async () => {
    scanProject.mockRejectedValue(new Error("boom"));
    expect(await collectCatalogMeta(config(["a"]))).toEqual({ complete: false, branch: "main" });
  });

  it("omits the branch when it is unknown", async () => {
    execFileSync.mockReturnValue("HEAD\n");
    fakeScan(["a"]);
    const saved = process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_REF_NAME;
    try {
      const meta = await collectCatalogMeta(config(["a"]));
      expect(meta).not.toHaveProperty("branch");
    } finally {
      if (saved !== undefined) process.env.GITHUB_REF_NAME = saved;
    }
  });
});
