#!/usr/bin/env node

import { Command } from "commander";
import pkg from "../package.json";
import { RESPAWN_ENV, exitWhenParentDies, respawnWithMoreHeap } from "./respawn";

// NO_COLOR (https://no-color.org) turns the colors off; chalk reads this when it is first loaded, which is later
if (process.env.NO_COLOR && !process.env.FORCE_COLOR) process.env.FORCE_COLOR = "0";

// the process a parent started with more memory follows its parent: no orphan when the parent is killed
if (process.env[RESPAWN_ENV]) exitWhenParentDies();

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
    .option("--strict", "exit with a non-zero code on skipped files, syntax errors, rejected names or unresolved dynamic names")
    .action(async (opts) => {
      const { sync } = await import("./cli/sync");
      await sync({ strict: opts.strict });
    });

  program
    .command("check")
    .option("--fix", "auto fix issues")
    .option("--strict", "exit with a non-zero code on skipped files, syntax errors, rejected names or unresolved dynamic names")
    .action(async (opts) => {
      const { check } = await import("./cli/check");
      await check({ fix: opts.fix, strict: opts.strict });
    });

  program
    .command("watch")
    .description("Watch files and detect events in real-time")
    .action(async () => {
      let loaded: typeof import("./cli/watch");
      try {
        loaded = await import("./cli/watch");
      } catch (err) {
        // the file watcher is an ES module, which an older Node cannot load with require()
        if ((err as NodeJS.ErrnoException).code === "ERR_REQUIRE_ESM") {
          throw new Error(`eventra watch needs Node.js 20.19+ or 22.12+ (this is ${process.versions.node}); sync, check and send work on this version.`);
        }
        throw err;
      }
      await loaded.watch();
    });

  program
    .command("send")
    .option("--trust-endpoint", "approve the current eventra.json endpoint for local use")
    .action(async (opts) => {
      const { send } = await import("./cli/send");
      await send({ trustEndpoint: opts.trustEndpoint });
    });

  // A command that never finishes (a plugin whose promise never settles) leaves Node with nothing to wait
  // for, and it exits with 0 as if all was well: a CI step would go green on a scan that never ended.
  let finished = false;
  process.on("exit", () => {
    if (!finished && process.exitCode === undefined) {
      console.error("Eventra stopped before the command finished: it was waiting for something that never came (an answer to a prompt, or a plugin that never completed). Run `eventra init --yes` for no prompts.");
      process.exitCode = 1;
    }
  });

  // an error is a message, not a stack trace; EVENTRA_DEBUG=1 brings the trace back
  program
    .parseAsync()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      if (process.env.EVENTRA_DEBUG && err instanceof Error && err.stack) console.error(err.stack);
      process.exitCode = 1;
    })
    .finally(() => {
      finished = true;
    });
}
