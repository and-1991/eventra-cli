import { spawn, spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.resolve(ROOT, "dist/index.js");

const fixtures: Array<{
  name: string;
  minEvents: number;
  minWrappers: number;
  expectWrappers?: string[];
  mustNotInclude?: string[];
}> = [
  {
    name: "sdk/direct",
    minEvents: 4,
    minWrappers: 0,
  },
  {
    name: "frontend/react",
    minEvents: 10,
    minWrappers: 0,
    mustNotInclude: ["object_track", "nested_track"],
  },
  {
    name: "wrappers/function",
    minEvents: 12,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "frontend/next",
    minEvents: 10,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "frontend/vue",
    minEvents: 0,
    minWrappers: 0,
  },
  {
    name: "backend/node",
    minEvents: 10,
    minWrappers: 0,
  },
  {
    name: "backend/express",
    minEvents: 25,
    minWrappers: 2,
  },
  {
    name: "backend/nest",
    minEvents: 8,
    minWrappers: 0,
  },
  {
    name: "watch-incremental",
    minEvents: 2,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "wrappers/barrel",
    minEvents: 3,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "wrappers/default-export",
    minEvents: 3,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "wrappers/path-aliases",
    minEvents: 3,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
];

function runCLI(args: string[], cwd: string): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    input: "\n",
  });
  return {
    stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    status: result.status ?? 1,
  };
}

function ensureTestConfig(dir: string) {
  const configPath = path.join(dir, "eventra.json");
  const config = {
    apiKey: "",
    events: [],
    functionWrappers: [],
    sync: {
      include: ["**/*.{ts,tsx,js,jsx}"],
      exclude: ["node_modules", "dist", ".next", ".git"],
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function cleanup(dir: string) {
  const configPath = path.join(dir, "eventra.json");
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

function runFixture(spec: (typeof fixtures)[number]) {
  const dir = path.resolve(__dirname, "fixtures", spec.name);
  console.log(`\nRunning: ${spec.name}`);

  ensureTestConfig(dir);
  const { stdout, status } = runCLI(["sync"], dir);
  if (status !== 0) {
    throw new Error(`CLI failed for ${spec.name}:\n${stdout}`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(dir, "eventra.json"), "utf-8"));
  const events: string[] = config.events ?? [];
  const wrappers: Array<{ name: string }> = config.functionWrappers ?? [];

  if (events.length < spec.minEvents) {
    throw new Error(
      `${spec.name}: expected >= ${spec.minEvents} events, got ${events.length}\n${stdout}\nevents: ${events.join(", ")}`,
    );
  }
  if (wrappers.length < spec.minWrappers) {
    throw new Error(
      `${spec.name}: expected >= ${spec.minWrappers} wrappers, got ${wrappers.length}\n${stdout}`,
    );
  }
  if (spec.expectWrappers) {
    const names = new Set(wrappers.map((w) => w.name));
    for (const expected of spec.expectWrappers) {
      if (!names.has(expected)) {
        // @ts-ignore
        throw new Error(`${spec.name}: missing wrapper "${expected}" in ${[...names].join(", ")}`);
      }
    }
  }
  if (spec.mustNotInclude) {
    for (const forbidden of spec.mustNotInclude) {
      if (events.includes(forbidden)) {
        throw new Error(`${spec.name}: must not include non-SDK event "${forbidden}"`);
      }
    }
  }

  for (const event of events) {
    if (event.length > 64) {
      throw new Error(`${spec.name}: event name exceeds SDK limit (64): "${event}"`);
    }
  }

  console.log(`✓ ${spec.name} OK (${events.length} events, ${wrappers.length} wrappers)`);
  cleanup(dir);
}

function runCheckExitCodes() {
  // exercises `eventra check` exit semantics on a known fixture
  const dir = path.resolve(__dirname, "fixtures", "wrappers/function");

  // 1. drift case: empty config → sync finds events → check must exit 1
  console.log(`\nRunning: check exit codes (drift)`);
  ensureTestConfig(dir);
  const drift = runCLI(["check"], dir);
  if (drift.status !== 1) {
    throw new Error(
      `check (drift): expected exit 1, got ${drift.status}\n${drift.stdout}`,
    );
  }
  console.log(`✓ check drift returns exit code 1`);

  // 2. --fix writes events into config
  console.log(`\nRunning: check --fix (writes config)`);
  const fix = runCLI(["check", "--fix"], dir);
  if (fix.status !== 0) {
    throw new Error(`check --fix: expected exit 0, got ${fix.status}\n${fix.stdout}`);
  }
  const fixed = JSON.parse(fs.readFileSync(path.join(dir, "eventra.json"), "utf-8"));
  if (!Array.isArray(fixed.events) || fixed.events.length === 0) {
    throw new Error(`check --fix: events should be populated`);
  }
  console.log(`✓ check --fix writes ${fixed.events.length} events`);

  // 3. parity: re-running check on the updated config should exit 0
  console.log(`\nRunning: check exit codes (parity)`);
  const parity = runCLI(["check"], dir);
  if (parity.status !== 0) {
    throw new Error(
      `check (parity): expected exit 0, got ${parity.status}\n${parity.stdout}`,
    );
  }
  console.log(`✓ check parity returns exit code 0`);

  cleanup(dir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(condition: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// `eventra watch` must notice brand-new files matching `sync.include`, not just
// edits to files it already knew about at startup — regression coverage for a
// bug where chokidar was handed a fixed file list instead of watching the
// project directory.
async function runWatchNewFileDetection(): Promise<void> {
  console.log(`\nRunning: watch (new file detection)`);
  const src = path.resolve(__dirname, "fixtures", "watch-incremental");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-watch-"));
  fs.cpSync(src, dir, { recursive: true });
  ensureTestConfig(dir);

  const child = spawn(process.execPath, [CLI, "watch"], { cwd: dir });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));

  try {
    const started = await waitFor(() => output.includes("Initial:"), 10_000);
    if (!started) {
      throw new Error(`watch: did not start within timeout\noutput:\n${output}`);
    }

    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    // chokidar watches directories individually (Linux inotify has no native
    // recursive watch), so a brand-new subdirectory needs its own watch set
    // up asynchronously before it can see anything created inside it - write
    // immediately after mkdirSync risks losing that race, especially on
    // slower/CI filesystems. Giving it a moment to settle avoids that.
    await sleep(500);
    fs.writeFileSync(
      path.join(dir, "routes", "newFeature.ts"),
      [
        `import { trackFeature } from "../middleware/tracking.middleware";`,
        `trackFeature("user.signup");`,
        "",
      ].join("\n"),
    );

    const detected = await waitFor(() => {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(dir, "eventra.json"), "utf-8"));
        return (config.events ?? []).includes("user.signup");
      } catch {
        return false;
      }
    }, 10_000);

    if (!detected) {
      throw new Error(`watch: new file's event was not detected within timeout\noutput:\n${output}`);
    }
    console.log(`✓ watch detects newly created files`);
  } finally {
    child.kill("SIGINT");
    await waitFor(() => child.exitCode !== null, 2_000);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  const build = spawnSync("pnpm", ["run", "build"], { cwd: ROOT, encoding: "utf-8" });
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    process.exit(1);
  }

  for (const fixture of fixtures) {
    runFixture(fixture);
  }

  runCheckExitCodes();
  await runWatchNewFileDetection();

  console.log("\nAll fixtures passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
