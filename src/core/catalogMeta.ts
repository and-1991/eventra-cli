import { execFileSync } from "child_process";

import type { EventraConfig } from "../types";
import type { DynamicOccurrence } from "../analysis/shared/dynamicOccurrence";
import { scanProject } from "./projectScanner";

const MAX_BRANCH_LENGTH = 200;

// CI systems usually check out a detached HEAD, so git cannot name the branch
// there; these variables can. First one set wins.
const BRANCH_ENV_VARS = [
  "GITHUB_REF_NAME",
  "CI_COMMIT_REF_NAME",
  "BRANCH_NAME",
  "BITBUCKET_BRANCH",
  "CIRCLE_BRANCH",
  "BUILDKITE_BRANCH",
  "VERCEL_GIT_COMMIT_REF",
] as const;

// A pull / merge request build checks out the PROPOSED code: a PR that deletes
// an event must not mark it removed on the project catalog.
const PULL_REQUEST_MARKERS: readonly ((env: NodeJS.ProcessEnv) => boolean)[] = [
  (env) => env.GITHUB_EVENT_NAME === "pull_request" || env.GITHUB_EVENT_NAME === "pull_request_target",
  (env) => (env.GITHUB_REF ?? "").startsWith("refs/pull/"),
  (env) => Boolean(env.CI_MERGE_REQUEST_IID) || env.CI_PIPELINE_SOURCE === "merge_request_event",
  (env) => Boolean(env.BITBUCKET_PR_ID),
  (env) => Boolean(env.CIRCLE_PULL_REQUEST || env.CIRCLE_PR_NUMBER),
  (env) => Boolean(env.BUILDKITE_PULL_REQUEST) && env.BUILDKITE_PULL_REQUEST !== "false",
  (env) => Boolean(env.VERCEL_GIT_PULL_REQUEST_ID),
  (env) => Boolean(env.TRAVIS_PULL_REQUEST) && env.TRAVIS_PULL_REQUEST !== "false",
  (env) => Boolean(env.SYSTEM_PULLREQUEST_PULLREQUESTID) || env.BUILD_REASON === "PullRequest",
  (env) => Boolean(env.CHANGE_ID),
];

/** True when the environment says this run is a pull / merge request build. */
export function isPullRequestBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return PULL_REQUEST_MARKERS.some((marker) => marker(env));
}

/** What `eventra send` tells the server about the scan behind the event list. */
export interface CatalogMeta {
  /**
   * True only when the list it sends is a full, trustworthy snapshot of the
   * code: the scan skipped nothing and hit no error, and eventra.json (the
   * list being sent) matches what the scan just found. The server marks names
   * missing from a complete snapshot as removed, so anything doubtful is false
   * (including any pull / merge request build, which sees proposed code).
   */
  readonly complete: boolean;
  /** Event-name call sites that could not be resolved to any string. Omitted when the scan failed. */
  readonly dynamicCount?: number;
  readonly branch?: string;
}

/** Best-effort current branch. Never throws; returns undefined when unknown. */
export function detectBranch(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  for (const name of BRANCH_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value.slice(0, MAX_BRANCH_LENGTH);
  }

  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // "HEAD" is what git prints for a detached checkout: not a branch name
    if (out && out !== "HEAD") return out.slice(0, MAX_BRANCH_LENGTH);
  } catch {
    // not a git checkout, git missing or too slow
  }

  return undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

// An Angular template module embeds a copy of its component class, so the same
// call is reported twice: once from the class file and once from that copy
// (inGeneratedCode). Only the real one is counted.
export function countUnresolved(occurrences: readonly DynamicOccurrence[]): number {
  return occurrences.filter((o) => o.resolvedValues.length === 0 && !o.inGeneratedCode).length;
}

/**
 * Scans the project again to find out whether the event list about to be sent
 * is complete. Never throws: any failure means complete = false.
 */
export async function collectCatalogMeta(config: EventraConfig): Promise<CatalogMeta> {
  const branch = detectBranch();
  const withBranch = (meta: CatalogMeta): CatalogMeta => (branch ? { ...meta, branch } : meta);

  try {
    const { engine, skipped } = await scanProject(config);
    const scanned = engine.getAllEvents();
    const dynamicCount = countUnresolved(engine.getAllDynamicOccurrences());
    const complete =
      skipped.length === 0 && !isPullRequestBuild() && sameSet(config.events ?? [], scanned);
    return withBranch({ complete, dynamicCount });
  } catch {
    return withBranch({ complete: false });
  }
}
