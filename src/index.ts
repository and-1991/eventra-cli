#!/usr/bin/env node

import { Command } from "commander";
import pkg from "../package.json";
import { respawnWithMoreHeap } from "./respawn";

// a large repository can need more memory than Node's default: start again with enough
respawnWithMoreHeap().then((respawned) => {
  if (!respawned) run();
});

function run(): void {
  const program = new Command();

  program
    .name("eventra")
    .description("Eventra CLI")
    .version(pkg.version);

  program
    .command("init")
    .option("-y, --yes", "do not prompt: accept defaults and keep an existing eventra.json")
    .action(async (opts) => {
      const { init } = await import("./cli/init");
      await init({ yes: opts.yes });
    });

  program
    .command("sync")
    .option("--strict", "exit with a non-zero code if any file could not be analysed")
    .action(async (opts) => {
      const { sync } = await import("./cli/sync");
      await sync({ strict: opts.strict });
    });

  program
    .command("check")
    .option("--fix", "auto fix issues")
    .option("--strict", "exit with a non-zero code if any file could not be analysed")
    .action(async (opts) => {
      const { check } = await import("./cli/check");
      await check({ fix: opts.fix, strict: opts.strict });
    });

  program
    .command("watch")
    .description("Watch files and detect events in real-time")
    .action(async () => {
      const { watch } = await import("./cli/watch");
      await watch();
    });

  program
    .command("send")
    .option("--trust-endpoint", "approve the current eventra.json endpoint for local use")
    .action(async (opts) => {
      const { send } = await import("./cli/send");
      await send({ trustEndpoint: opts.trustEndpoint });
    });

  program.parse();
}
