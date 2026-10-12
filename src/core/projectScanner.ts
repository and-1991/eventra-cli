import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";

import { EventraConfig, ScanResult } from "../types";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "./EventraEngine";
import { processFile } from "../filesystem/processFile";
import { getVirtualFile } from "../filesystem/getVirtualFile";
import { createPluginRegistry } from "../plugin/loadPlugins";
import type { PluginRegistry } from "../plugin/registry";
import { expandExcludePatterns } from "./scanFilters";
import { type SkippedFile, skippedFrom } from "./skipped";
import { OVERSIZED_REASON, isOversized } from "./fileLimits";

const SDK_TYPES_FILE = "__eventra_sdk_types__.d.ts";

interface CachedFile {
  readonly content: string;
  readonly dependencies: readonly string[];
}

export interface ProjectScanResult {
  readonly engine: EventraEngine;
  readonly results: Map<string, ScanResult>;
  readonly files: readonly string[];
  readonly plugins: PluginRegistry;
  /** Files that could not be analysed, with the reason; their events are missing from `results`. */
  readonly skipped: readonly SkippedFile[];
  /** Files deliberately not analysed (over the size limit). Not failures: see formatIgnored. */
  readonly ignored: readonly SkippedFile[];
}

export async function scanProject(config: EventraConfig): Promise<ProjectScanResult> {
  const plugins = await createPluginRegistry(config);
  const include = [...config.sync.include, ...plugins.getIncludePatterns()];

  const files = await fg(include, {
    ignore: expandExcludePatterns(config.sync.exclude),
    absolute: true,
  });

  const engine = new EventraEngine(process.cwd(), plugins);
  const cache = new Map<string, CachedFile>();
  const toScan = new Set<string>();
  const skipped: SkippedFile[] = [];
  const ignored: SkippedFile[] = [];

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf8");
      if (isOversized(raw)) {
        ignored.push({ file, reason: OVERSIZED_REASON });
        continue;
      }

      const virtualFiles = await plugins.preprocessFile({ fileName: file, content: raw });

      for (const virtualFile of virtualFiles) {
        const parsed = await processFile(virtualFile.fileName, virtualFile.content);
        const scanPath = path.resolve(virtualFile.fileName);
        cache.set(scanPath, parsed);
        toScan.add(scanPath);
      }
    } catch (err) {
      skipped.push(skippedFrom(file, err));
    }
  }

  const virtualFiles = [SDK_TYPES_FILE, ...toScan].map((f) => getVirtualFile(f));

  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of toScan) {
    // every path in toScan was parsed and cached in the loop above
    await engine.preloadFile(getVirtualFile(file), cache.get(file)!.content);
  }
  engine.endPreload();

  await engine.runFullAnalysis(virtualFiles, config);

  const results = new Map<string, ScanResult>();
  for (const file of toScan) {
    results.set(file, engine.getScanResult(getVirtualFile(file)));
  }

  return {
    engine,
    results,
    files,
    plugins,
    skipped,
    ignored,
  };
}
