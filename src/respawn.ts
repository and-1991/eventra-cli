import { spawn } from "child_process";
import os from "os";
import v8 from "v8";

/** Set on the child, so a process started with more memory never starts another one. */
export const RESPAWN_ENV = "EVENTRA_HEAP_RESPAWNED";

/** The commands that read the whole project; the rest (`init`, `--version`, `--help`) stay in one process. */
export const SCANNING_COMMANDS: ReadonlySet<string> = new Set(["sync", "check", "watch", "send"]);

const MIB = 1024 * 1024;
// a project of tens of thousands of files needs a few GB while its program is built; more than
// this is never useful, and half the machine's memory is what can be taken without hurting it
const MAX_HEAP_MB = 8192;
const SHARE_OF_MEMORY = 0.5;

/** Signals a parent passes on, so stopping it stops the child too instead of leaving it running. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * The old-space limit (MB) worth starting with, or `undefined` to carry on as is: Node's default
 * limit is a fraction of the memory and can be well below what a large monorepo needs.
 */
export function wantedHeapMb(availableMemoryBytes: number, currentLimitBytes: number): number | undefined {
  const wanted = Math.min(MAX_HEAP_MB, Math.floor((availableMemoryBytes * SHARE_OF_MEMORY) / MIB));
  // not worth a second process for a small difference
  return wanted > (currentLimitBytes / MIB) * 1.25 ? wanted : undefined;
}

export interface RespawnDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  readonly execPath: string;
  /** Memory this process may really use: the machine's, or the container's when it has a lower limit. */
  readonly availableMemoryBytes: number;
  readonly heapLimitBytes: number;
  /** Runs the command and resolves with its exit code; stopping this process stops the child too. */
  readonly run: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
  readonly exit: (code: number) => void;
}

/**
 * Memory this process can use: the smaller of the machine's and the container's limit (cgroups) when it has
 * one. `constrained` is 0 when nothing limits the process, and undefined on a Node that does not report it.
 */
export function usableMemory(total: number, constrained: number | undefined): number {
  return constrained !== undefined && constrained > 0 ? Math.min(total, constrained) : total;
}

function runChild(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "inherit", env });
    const forwarders = FORWARDED_SIGNALS.map((signal) => {
      const forward = () => child.kill(signal);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const done = (code: number) => {
      for (const [signal, forward] of forwarders) process.off(signal, forward);
      resolve(code);
    };
    // a child that could not start at all (`error`) counts as a failed run, like one killed by a signal
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

export const defaultRespawnDeps = (): RespawnDeps => ({
  env: process.env,
  execArgv: process.execArgv,
  argv: process.argv,
  execPath: process.execPath,
  availableMemoryBytes: usableMemory(os.totalmem(), (os as { constrainedMemory?: () => number }).constrainedMemory?.()),
  heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  run: runChild,
  exit: (code) => process.exit(code),
});

/**
 * Runs a scanning command again in a child with a larger heap when this process would start with too
 * little, and exits with the child's status. Resolves `true` when it did, so the caller stops there. An
 * explicit `--max-old-space-size` (in NODE_OPTIONS or the command line) is the user's choice and is left alone.
 */
export async function respawnWithMoreHeap(deps: RespawnDeps = defaultRespawnDeps()): Promise<boolean> {
  if (deps.env[RESPAWN_ENV]) return false;
  // a second process costs startup time, so only a command that scans a project is worth it
  if (!SCANNING_COMMANDS.has(deps.argv[2] ?? "")) return false;
  const explicit = [deps.env.NODE_OPTIONS ?? "", ...deps.execArgv].some((part) => part.includes("max-old-space-size"));
  if (explicit) return false;
  const heapMb = wantedHeapMb(deps.availableMemoryBytes, deps.heapLimitBytes);
  if (heapMb === undefined) return false;

  const code = await deps.run(
    deps.execPath,
    [`--max-old-space-size=${heapMb}`, ...deps.execArgv, ...deps.argv.slice(1)],
    { ...deps.env, [RESPAWN_ENV]: "1" },
  );
  deps.exit(code);
  return true;
}
