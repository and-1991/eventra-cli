import type { PresetPackage } from "../src/plugin/builtins/sinkPresets";

/** The part of an npm registry document ("packument") this check reads. */
export interface Packument {
  readonly "dist-tags"?: { readonly latest?: string };
  readonly versions?: Readonly<Record<string, { readonly deprecated?: string } | undefined>>;
  readonly time?: Readonly<Record<string, string | undefined>>;
}

export interface PackageVerdict {
  readonly name: string;
  readonly level: "ok" | "info" | "warn" | "error";
  readonly latest?: string;
  readonly published?: string;
  readonly message: string;
}

/** A maintained (non-legacy) package that has not been published for this long is suspicious. */
export const STALE_AFTER_DAYS = 3 * 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Judges one preset package against the registry:
 * - missing from the registry, or its latest version deprecated while not marked `legacy`: error
 * - maintained but not published for 3 years: warn
 * - marked `legacy` but neither deprecated nor stale: info (still worth a look, it may be maintained again)
 */
export function judgePackage(pkg: PresetPackage, packument: Packument | null, now: Date): PackageVerdict {
  if (!packument) {
    return { name: pkg.name, level: "error", message: "not found in the npm registry" };
  }
  const latest = packument["dist-tags"]?.latest;
  const published = latest ? packument.time?.[latest]?.slice(0, 10) : undefined;
  const deprecated = latest ? packument.versions?.[latest]?.deprecated : undefined;
  const base = { name: pkg.name, latest, published };

  if (deprecated && !pkg.legacy) {
    return { ...base, level: "error", message: `latest version is deprecated: ${deprecated.slice(0, 100)}` };
  }
  const ageDays = published ? (now.getTime() - new Date(published).getTime()) / DAY_MS : 0;
  if (!pkg.legacy && ageDays > STALE_AFTER_DAYS) {
    return { ...base, level: "warn", message: `not published since ${published}` };
  }
  if (pkg.legacy) {
    return { ...base, level: "info", message: deprecated ? "legacy, deprecated as expected" : "legacy, not deprecated" };
  }
  return { ...base, level: "ok", message: "current" };
}

/** Process exit code for a set of verdicts: 1 if any package is missing or wrongly deprecated. */
export function exitCodeFor(verdicts: readonly PackageVerdict[]): number {
  return verdicts.some((v) => v.level === "error") ? 1 : 0;
}
