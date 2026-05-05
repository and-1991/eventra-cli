import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.resolve(ROOT, "dist/index.js");

const fixtures = [
  "frontend/react",
  "frontend/vue",
  "frontend/next",

  "backend/node",
  "backend/express",
  "backend/nest",

  "wrappers/component",
  "wrappers/function"
];

function runCLI(args: string[], cwd: string): string {
  const result = spawnSync(
    process.execPath,
    [CLI, ...args],
    {
      cwd,
      encoding: "utf-8",
      input: "\n"
    }
  );

  return (result.stdout ?? "") + (result.stderr ?? "");
}

function ensureTestConfig(dir: string) {
  const configPath = path.join(dir, "eventra.json");

  const config = {
    apiKey: "",
    events: [],
    wrappers: [],
    functionWrappers: [],
    sync: {
      include: [
        "**/*.{ts,tsx,js,jsx,vue,svelte,astro}"
      ],
      exclude: [
        "node_modules",
        "dist",
        ".next",
        ".git"
      ]
    }
  };

  fs.writeFileSync(
    configPath,
    JSON.stringify(config, null, 2)
  );
}

function cleanup(dir: string) {
  const configPath = path.join(dir, "eventra.json");

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

function runFixture(name: string) {
  const dir = path.resolve(
    __dirname,
    "fixtures",
    name
  );

  console.log(`\nRunning: ${name}`);

  ensureTestConfig(dir);

  const output = runCLI(["sync"], dir);

  const match =
    output.match(/Found (\d+) events/);

  const count = match ? match[1] : "0";

  console.log(
    `✓ ${name} OK (${count} events)`
  );

  // cleanup
  cleanup(dir);
}

function run() {
  for (const fixture of fixtures) {
    runFixture(fixture);
  }

  console.log(
    "\nAll fixtures passed"
  );
}

run();
