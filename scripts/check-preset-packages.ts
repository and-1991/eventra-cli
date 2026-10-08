/**
 * Checks every npm package the `sinks` presets rely on against the live registry, so a rename, a
 * removal or a deprecation is noticed here instead of as silent missed events.
 *
 *   pnpm check:presets
 *
 * Exit code: 0 all fine, 1 a package is missing or wrongly deprecated, 2 the registry was unreachable.
 */
import { PRESET_PACKAGES } from "../src/plugin/builtins/sinkPresets";
import { exitCodeFor, judgePackage, type Packument, type PackageVerdict } from "./preset-packages-lib";

const REGISTRY = "https://registry.npmjs.org/";

async function fetchPackument(name: string): Promise<Packument | null> {
  const response = await fetch(REGISTRY + name.replace("/", "%2F"), { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`);
  return (await response.json()) as Packument;
}

async function main(): Promise<number> {
  const now = new Date();
  const verdicts: Array<PackageVerdict & { preset: string }> = [];
  try {
    for (const [preset, packages] of Object.entries(PRESET_PACKAGES)) {
      const results = await Promise.all(
        packages.map(async (pkg) => ({ ...judgePackage(pkg, await fetchPackument(pkg.name), now), preset })),
      );
      verdicts.push(...results);
    }
  } catch (error) {
    console.error(`Could not reach the npm registry: ${(error as Error).message}`);
    return 2;
  }
  for (const v of verdicts) {
    const mark = { ok: "ok   ", info: "info ", warn: "WARN ", error: "ERROR" }[v.level];
    console.log(`${mark} ${v.preset.padEnd(9)} ${v.name.padEnd(42)} ${(v.latest ?? "-").padEnd(10)} ${v.published ?? "-"}  ${v.message}`);
  }
  console.log(`\nChecked ${verdicts.length} packages on ${now.toISOString().slice(0, 10)}.`);
  return exitCodeFor(verdicts);
}

main().then((code) => process.exit(code));
