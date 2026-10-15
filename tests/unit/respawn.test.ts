import { describe, expect, it, vi } from "vitest";

import {
  RESPAWN_ENV,
  SCANNING_COMMANDS,
  defaultRespawnDeps,
  respawnWithMoreHeap,
  usableMemory,
  wantedHeapMb,
  type RespawnDeps,
} from "../../src/respawn";

const GB = 1024 ** 3;

describe("usableMemory", () => {
  it("is the machine's memory when nothing limits the process", () => {
    expect(usableMemory(16 * GB, 0)).toBe(16 * GB);
    expect(usableMemory(16 * GB, undefined)).toBe(16 * GB);
  });

  it("is the container's limit when it is lower, and the machine's when it is not", () => {
    expect(usableMemory(32 * GB, 2 * GB)).toBe(2 * GB);
    expect(usableMemory(4 * GB, 64 * GB)).toBe(4 * GB);
  });
});

describe("wantedHeapMb", () => {
  it("takes half of the memory, up to 8 GB", () => {
    expect(wantedHeapMb(16 * GB, 2 * GB)).toBe(8192);
    expect(wantedHeapMb(64 * GB, 2 * GB)).toBe(8192);
    expect(wantedHeapMb(8 * GB, 2 * GB)).toBe(4096);
  });

  it("leaves a heap that is already close to it alone", () => {
    expect(wantedHeapMb(16 * GB, 8 * GB)).toBeUndefined();
    expect(wantedHeapMb(8 * GB, 3.5 * GB)).toBeUndefined();
    expect(wantedHeapMb(8 * GB, 3 * GB)).toBe(4096);
  });

  it("follows a container's smaller limit, not the host's memory", () => {
    // a 2 GB container on a big host must not be handed an 8 GB heap
    expect(wantedHeapMb(2 * GB, 0.5 * GB)).toBe(1024);
    expect(wantedHeapMb(2 * GB, 1 * GB)).toBeUndefined();
  });
});

function deps(overrides: Partial<RespawnDeps> = {}) {
  const run = vi.fn(async () => 0);
  const exit = vi.fn();
  const all: RespawnDeps = {
    env: {},
    execArgv: [],
    argv: ["/usr/bin/node", "/x/eventra", "sync", "--strict"],
    execPath: "/usr/bin/node",
    availableMemoryBytes: 16 * GB,
    heapLimitBytes: 2 * GB,
    run,
    exit,
    ...overrides,
  };
  return { all, run, exit };
}

describe("respawnWithMoreHeap", () => {
  it("runs the same command again with a bigger heap and exits with its status", async () => {
    const run = vi.fn(async () => 3);
    const { all, exit } = deps({ run });
    expect(await respawnWithMoreHeap(all)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["--max-old-space-size=8192", "/x/eventra", "sync", "--strict"],
      { [RESPAWN_ENV]: "1" },
    );
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("keeps the node flags of the parent", async () => {
    const { all, run } = deps({ execArgv: ["--enable-source-maps"] });
    await respawnWithMoreHeap(all);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["--max-old-space-size=8192", "--enable-source-maps", "/x/eventra", "sync", "--strict"],
      expect.anything(),
    );
  });

  it.each(["sync", "check", "watch", "send"])("respawns for the scanning command `%s`", async (command) => {
    const { all, run } = deps({ argv: ["/usr/bin/node", "/x/eventra", command] });
    expect(await respawnWithMoreHeap(all)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([["init"], ["--version"], ["--help"], ["help"], ["unknown"]])("stays in one process for `%s`", async (command) => {
    const { all, run } = deps({ argv: ["/usr/bin/node", "/x/eventra", command] });
    expect(await respawnWithMoreHeap(all)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("stays in one process when no command was given", async () => {
    const { all, run } = deps({ argv: ["/usr/bin/node", "/x/eventra"] });
    expect(await respawnWithMoreHeap(all)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("lists exactly the commands that scan", () => {
    expect([...SCANNING_COMMANDS].sort()).toEqual(["check", "send", "sync", "watch"]);
  });

  it("does nothing in the child it started", async () => {
    const { all, run } = deps({ env: { [RESPAWN_ENV]: "1" } });
    expect(await respawnWithMoreHeap(all)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("respects a heap size the user set, in NODE_OPTIONS or on the command line", async () => {
    const viaEnv = deps({ env: { NODE_OPTIONS: "--max-old-space-size=1024" } });
    expect(await respawnWithMoreHeap(viaEnv.all)).toBe(false);
    const viaFlag = deps({ execArgv: ["--max-old-space-size=1024"] });
    expect(await respawnWithMoreHeap(viaFlag.all)).toBe(false);
    expect(viaEnv.run).not.toHaveBeenCalled();
    expect(viaFlag.run).not.toHaveBeenCalled();
  });

  it("does nothing when the heap is big enough already", async () => {
    const { all, run } = deps({ heapLimitBytes: 8 * GB });
    expect(await respawnWithMoreHeap(all)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("works from the real process values (an already-respawned process stays put)", async () => {
    const previous = process.env[RESPAWN_ENV];
    process.env[RESPAWN_ENV] = "1";
    try {
      expect(await respawnWithMoreHeap()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[RESPAWN_ENV];
      else process.env[RESPAWN_ENV] = previous;
    }
  });
});

describe("the real dependencies", () => {
  it("run a child process and pass its exit code on", async () => {
    const real = defaultRespawnDeps();
    expect(await real.run(process.execPath, ["-e", "process.exit(7)"], process.env)).toBe(7);
    expect(real.availableMemoryBytes).toBeGreaterThan(0);
    expect(real.heapLimitBytes).toBeGreaterThan(0);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      real.exit(5);
      expect(exit).toHaveBeenCalledWith(5);
    } finally {
      exit.mockRestore();
    }
  });

  it("forward a stop signal to the child, so it is not left running, and stop listening afterwards", async () => {
    const real = defaultRespawnDeps();
    const before = process.listenerCount("SIGTERM");
    const running = real.run(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => process.exit(9)); setInterval(() => {}, 1000); console.log('ready')"],
      process.env,
    );
    // give the child time to install its handler, then stop the parent the way `kill` would
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    expect(await running).toBe(9);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("count a child killed by a signal, or one that cannot start, as a failed run", async () => {
    const real = defaultRespawnDeps();
    expect(await real.run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], process.env)).toBe(1);
    expect(await real.run("/definitely/not/a/binary", [], process.env)).toBe(1);
  });

  it("do not pass an exit code of 0 through as a failure", async () => {
    expect(await defaultRespawnDeps().run(process.execPath, ["-e", ""], process.env)).toBe(0);
  });
});
