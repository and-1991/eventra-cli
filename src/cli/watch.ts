import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { CONFIG_NAME, LOCAL_CONFIG_NAME, requireConfig } from "../config/config";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "../core/EventraEngine";
import { persistScanResults } from "../core/scanResults";
import { createPluginRegistry } from "../plugin/loadPlugins";
import { createFileFilter, expandExcludePatterns } from "../core/scanFilters";
import {
  type SkippedFile,
  errorMessage,
  plural,
  reportIgnored,
  reportSkipped,
  skippedFrom,
} from "../core/skipped";
import { OVERSIZED_REASON, isOversized } from "../core/fileLimits";
import { getVirtualFile } from "../filesystem/getVirtualFile";

const SDK_TYPES_FILE = "__eventra_sdk_types__.d.ts";

// Files outside `include` can still change what a scanned file means when
// something imports them (a shared constants module, a wrapper in a helper).
// Only code-like files are worth rebuilding the program for.
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|json)$/;

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export interface WatchHandle {
  close(): Promise<void>;
}

export async function watch(): Promise<WatchHandle | undefined> {
  const config = await requireConfig();
  if (!config) return undefined;

  console.log(chalk.blue("Watching...\n"));
  const plugins = await createPluginRegistry(config);
  const include = [...config.sync.include, ...plugins.getIncludePatterns()];
  const engine = new EventraEngine(process.cwd(), plugins);
  const watchedDeps = new Set<string>();
  const trackedFiles = new Set<string>();
  const sourceFiles = new Set<string>();
  // files whose last analysis failed; while there are any, saved results keep
  // the previously known events (see buildConfigFromScan)
  const skippedNow = new Map<string, SkippedFile>();

  const normalize = (file: string): string => {
    return path.resolve(file).replace(/\\/g, "/");
  };

  // The same rules as the initial scan (and as `sync`): plain exclude names match
  // at any depth, and a changed file is only handled when it matches `include`.
  // The config files are written by this process, so they must never trigger a run.
  const filter = createFileFilter(include, config.sync.exclude, process.cwd(), [
    CONFIG_NAME,
    LOCAL_CONFIG_NAME,
  ]);
  const isExcludedPath = (file: string): boolean => filter.isExcluded(normalize(file));
  const isSource = (abs: string): boolean =>
    sourceFiles.has(abs) || trackedFiles.has(abs) || filter.isIncluded(abs);
  // an imported (or newly importable) file outside `include`
  const isDependencyCandidate = (abs: string): boolean => CODE_FILE.test(abs) && !isSource(abs);
  const shouldHandle = (abs: string): boolean =>
    !filter.isExcluded(abs) && (isSource(abs) || isDependencyCandidate(abs));
  // what eventra.json holds now: "keep the known events" while a file is broken
  // must mean the events this process saved last, not the ones at startup
  let saved = config;
  const persist = async (): Promise<void> => {
    saved = await persistScanResults(saved, engine, { preserveKnown: skippedNow.size > 0 });
  };
  const signature = (): string => JSON.stringify([engine.getAllEvents(), engine.getAllFunctionWrappers()]);

  const files = await fg(include, {
    ignore: expandExcludePatterns(config.sync.exclude),
    absolute: true,
  });

  const ignoredInitial: SkippedFile[] = [];
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of files) {
    try {
      const abs = normalize(file);
      const raw = await fs.readFile(abs, "utf-8");
      // the same limit as `sync`: too big to analyse, but not a failure
      if (isOversized(raw)) {
        ignoredInitial.push({ file: abs, reason: OVERSIZED_REASON });
        continue;
      }
      sourceFiles.add(abs);
      const virtualFiles = await plugins.preprocessFile({ fileName: abs, content: raw });

      for (const virtualFile of virtualFiles) {
        const scanPath = normalize(virtualFile.fileName);
        trackedFiles.add(scanPath);
        await engine.preloadFile(getVirtualFile(scanPath), virtualFile.content);
      }
    } catch (err) {
      const skip = skippedFrom(file, err);
      skippedNow.set(normalize(file), skip);
    }
  }
  engine.endPreload();
  reportSkipped([...skippedNow.values()]);
  reportIgnored(ignoredInitial);

  await engine.runFullAnalysis(
    [SDK_TYPES_FILE, ...trackedFiles].map((f) => getVirtualFile(f)),
    config,
  );
  await persist();

  const initialEvents = engine.getAllEvents();
  const initialWrappers = engine.getAllFunctionWrappers();
  console.log(
    chalk.gray(
      `Initial: ${plural(initialEvents.length, "event")}, ${plural(initialWrappers.length, "wrapper")}\n`,
    ),
  );

  // Watch the project root (not just the files found by the initial scan) so
  // that brand-new files matching `include` are noticed as they're created -
  // a fixed file list only ever detects edits to files chokidar already knows
  // about. Project files that live outside the root are added below.
  const watcher = chokidar.watch(process.cwd(), {
    ignoreInitial: true,
    ignored: isExcludedPath,
  });

  const root = normalize(process.cwd());
  const isOutsideRoot = (abs: string): boolean => abs !== root && !abs.startsWith(`${root}/`);

  // Imported files outside the project root are not covered by the root
  // watcher: follow exactly the ones the program really resolved.
  const syncOutsideDeps = (): void => {
    const outside = new Set(
      engine
        .getProjectFileNames()
        .map(normalize)
        .filter((file) => isOutsideRoot(file) && !filter.isExcluded(file) && CODE_FILE.test(file)),
    );
    for (const dep of outside) {
      if (watchedDeps.has(dep)) continue;
      watcher.add(dep);
      watchedDeps.add(dep);
    }
    for (const dep of [...watchedDeps]) {
      if (outside.has(dep)) continue;
      watcher.unwatch(dep);
      watchedDeps.delete(dep);
    }
  };
  syncOutsideDeps();

  const queue = new Map<string, boolean>();
  let timer: NodeJS.Timeout | null = null;

  // a source file is gone (deleted, or no longer analysable such as one that grew past the size limit)
  const dropSource = async (abs: string): Promise<void> => {
    sourceFiles.delete(abs);
    skippedNow.delete(abs);
    for (const virtualPath of plugins.getVirtualPathsForSource(abs)) {
      trackedFiles.delete(virtualPath);
      await engine.removeFile(getVirtualFile(virtualPath), config);
    }
  };

  const run = async (): Promise<void> => {
    const batch = [...queue.keys()];
    queue.clear();
    if (batch.length === 0) return;
    const before = signature();
    let touchedSource = false;
    const skippedThisRun: SkippedFile[] = [];
    const ignoredThisRun: SkippedFile[] = [];

    // imported files outside `include` that changed, appeared or vanished: one rebuild for all of them
    const external = batch.filter((file) => !isSource(file));
    if (external.length > 0) {
      try {
        await engine.refreshExternalFiles(external, config);
      } catch (err) {
        console.error(chalk.red(`watch error: ${errorMessage(err)}`));
      }
    }

    for (const file of batch) {
      if (!isSource(file)) continue;

      touchedSource = true;
      try {
        const raw = await fs.readFile(file, "utf-8");
        if (isOversized(raw)) {
          // too big to analyse, like `sync`: not a failure, and its events are not kept
          await dropSource(file);
          ignoredThisRun.push({ file, reason: OVERSIZED_REASON });
          continue;
        }
        const virtualFiles = await plugins.preprocessFile({ fileName: file, content: raw });
        sourceFiles.add(file);
        skippedNow.delete(file);

        for (const virtualFile of virtualFiles) {
          const scanPath = normalize(virtualFile.fileName);
          trackedFiles.add(scanPath);
          await engine.updateFile(getVirtualFile(scanPath), virtualFile.content, config);
        }
      } catch (err) {
        if (isNotFound(err)) {
          // gone before it could be read (created and deleted within one debounce, or removed mid-run)
          await dropSource(file);
          continue;
        }
        const skip = skippedFrom(file, err);
        skippedNow.set(file, skip);
        skippedThisRun.push(skip);
      }
    }

    reportSkipped(skippedThisRun);
    reportIgnored(ignoredThisRun);
    syncOutsideDeps();

    // a batch of imported-only files that changed nothing about the result is not worth a write or a log line
    if (!touchedSource && signature() === before) return;

    await persist();
    console.log(
      chalk.green(
        `Updated: ${plural(engine.getAllEvents().length, "event")}, ${plural(engine.getAllFunctionWrappers().length, "wrapper")}`,
      ),
    );
  };

  // One run at a time: a timer firing while the previous run is still awaiting
  // would otherwise interleave two runs over the same engine.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((err: unknown) => {
      console.error(chalk.red(`watch error: ${errorMessage(err)}`));
    });
  };

  const schedule = (file: string): void => {
    const abs = normalize(file);
    if (!shouldHandle(abs)) return;
    queue.set(abs, true);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => enqueue(run), 200);
  };

  watcher
    .on("change", schedule)
    .on("add", schedule)
    .on("unlink", (file): void => {
      const abs = normalize(file);
      // chokidar's `ignored` already drops excluded paths, so this only guards against a stray event
      /* v8 ignore next */
      if (filter.isExcluded(abs)) return;
      // a file that failed to analyse is in no set but is still remembered as skipped
      if (!sourceFiles.has(abs) && !trackedFiles.has(abs) && !skippedNow.has(abs)) {
        // an imported-only file vanished: dependents resolve differently now
        if (CODE_FILE.test(abs) && engine.hasProgramFile(abs)) {
          queue.set(abs, true);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => enqueue(run), 200);
        }
        return;
      }
      enqueue(async (): Promise<void> => {
        await dropSource(abs);
        await persist();
        console.log(
          chalk.red(
            `Removed -> ${plural(engine.getAllEvents().length, "event")}, ${plural(engine.getAllFunctionWrappers().length, "wrapper")}`,
          ),
        );
      });
    });

  process.on("SIGINT", async (): Promise<void> => {
    await watcher.close();
    process.exit(0);
  });

  return {
    close: async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      await chain;
    },
  };
}
