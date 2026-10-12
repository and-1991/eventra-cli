import { runSeed } from "./harness";

// usage: tsx tests/differential/run.ts <firstSeed> <lastSeed> <steps> <small|large> [keepGoing]
// Each seed alternates between "with tsconfig" and "without" so both root-name
// modes of the compiler context are covered.
async function main(): Promise<void> {
  const [first = "1", last = "1", steps = "50", size = "small", keep = ""] = process.argv.slice(2);
  let failed = 0;
  let totalSteps = 0;
  for (let seed = Number(first); seed <= Number(last); seed++) {
    const large = size === "large";
    const report = await runSeed({
      seed,
      steps: Number(steps),
      initialFiles: large ? 60 : 8,
      dirs: large ? ["", "src/", "src/a/", "src/b/", "pkg/x/"] : ["", "sub/"],
      tsconfig: seed % 2 === 0,
      keepGoing: keep === "keepGoing",
    });
    totalSteps += report.steps;
    if (report.mismatches.length === 0) {
      console.log(`seed ${seed}: ok (${report.steps} steps, ${report.files} files)`);
    } else {
      failed++;
      const m = report.mismatches[0]!;
      console.log(`seed ${seed}: MISMATCH at step ${m.step} (${m.description})\n${m.detail}`);
    }
  }
  console.log(`DONE seeds ${first}-${last}: ${failed} failed, ${totalSteps} steps`);
  process.exitCode = failed ? 1 : 0;
}

void main();
