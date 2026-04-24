#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("eventra")
  .description("Eventra CLI")
  .version("0.0.1");

program
  .command("init")
  .description("Initialize Eventra")
  .action(async () => {
    const { init } = await import("./commands/init");
    await init();
  });

program
  .command("sync")
  .description("Sync events")
  .action(async () => {
    const { sync } = await import("./commands/sync");
    await sync();
  });

program
  .command("check")
  .description("Validate events (CI mode)")
  .action(async () => {
    const { check } = await import("./commands/check");
    await check();
  });

program
  .command("send")
  .description("Send events")
  .action(async () => {
    const { send } = await import("./commands/send");
    await send();
  });

program.parse();
