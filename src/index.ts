#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("eventra")
  .description("Eventra CLI")
  .version("0.0.1");

program
  .command("init")
  .action(async () => {
    const { init } = await import("./commands/init");
    await init();
  });

program
  .command("sync")
  .action(async () => {
    const { sync } = await import("./commands/sync");
    await sync();
  });

program
  .command("check")
  .option("--fix", "auto fix issues")
  .action(async (opts) => {
    const { check } = await import("./commands/check");
    await check({ fix: opts.fix });
  });

program
  .command("watch")
  .description("Watch files and detect events in real-time")
  .action(async () => {
    const { watch } = await import("./commands/watch");
    await watch();
  });

program
  .command("send")
  .action(async () => {
    const { send } = await import("./commands/send");
    await send();
  });

program.parse();
