import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.resolve(ROOT, "dist/index.js");

const fixtures: Array<{
  name: string;
  minEvents: number;
  minWrappers: number;
  expectWrappers?: string[];
}> = [
  {
    name: "frontend/react",
    minEvents: 5,
    minWrappers: 0,
  },
  {
    name: "wrappers/function",
    minEvents: 5,
    minWrappers: 1,
    expectWrappers: ["trackFeature"],
  },
  {
    name: "frontend/vue",
    minEvents: 0,
    minWrappers: 0,
  },
  {
    name: "frontend/next",
    minEvents: 0,
    minWrappers: 0,
  },
  {
    name: "backend/node",
    minEvents: 0,
    minWrappers: 0,
  },
  {
    name: "backend/express",
    minEvents: 0,
    minWrappers: 0,
  },
  {
    name: "backend/nest",
    minEvents: 0,
    minWrappers: 0,
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
      `${spec.name}: expected >= ${spec.minEvents} events, got ${events.length}\n${stdout}`,
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
        throw new Error(`${spec.name}: missing wrapper "${expected}" in ${[...names].join(", ")}`);
      }
    }
  }

  console.log(`✓ ${spec.name} OK (${events.length} events, ${wrappers.length} wrappers)`);
  cleanup(dir);
}

function run() {
  const build = spawnSync("pnpm", ["run", "build"], { cwd: ROOT, encoding: "utf-8" });
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    process.exit(1);
  }

  for (const fixture of fixtures) {
    runFixture(fixture);
  }

  console.log("\nAll fixtures passed");
}

run();
