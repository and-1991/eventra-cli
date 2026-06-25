import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";

import { EventraConfig, ScanResult } from "../types";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "./EventraEngine";
import { processFile } from "../filesystem/processFile";
import { getVirtualFile } from "../filesystem/getVirtualFile";
import { createPluginRegistry } from "../plugin/loadPlugins";

const SDK_TYPES_FILE = "__eventra_sdk_types__.d.ts";

interface CachedFile {
  readonly content: string;
  readonly dependencies: readonly string[];
}

export interface ProjectScanResult {
  readonly engine: EventraEngine;
  readonly results: Map<string, ScanResult>;
  readonly files: readonly string[];
}

async function getParsedFile(file: string, cache: Map<string, CachedFile>): Promise<CachedFile> {
  const existing = cache.get(file);
  if (existing) return existing;

  const raw = await fs.readFile(file, "utf8");
  const parsed = await processFile(file, raw);
  cache.set(file, parsed);
  return parsed;
}

export async function scanProject(config: EventraConfig): Promise<ProjectScanResult> {
  const plugins = await createPluginRegistry(config);
  const include = [...config.sync.include, ...plugins.getIncludePatterns()];

  const files = await fg(include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  const engine = new EventraEngine(process.cwd(), plugins);
  const cache = new Map<string, CachedFile>();
  const toScan = new Set<string>();

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf8");
      if (raw.length > 2_000_000) continue;

      const virtualFiles = await plugins.preprocessFile({ fileName: file, content: raw });

      for (const virtualFile of virtualFiles) {
        const parsed = await processFile(virtualFile.fileName, virtualFile.content);
        const scanPath = path.resolve(virtualFile.fileName);
        cache.set(scanPath, parsed);
        toScan.add(scanPath);
        for (const dep of parsed.dependencies) {
          if (dep.startsWith(".") || dep.startsWith("/")) {
            toScan.add(path.resolve(path.dirname(scanPath), dep));
          }
        }
      }
    } catch (err) {
      console.error(`skip: ${file}`, err instanceof Error ? err.message : err);
    }
  }

  const virtualFiles = [SDK_TYPES_FILE, ...toScan].map((f) => getVirtualFile(f));

  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of toScan) {
    try {
      const parsed = await getParsedFile(file, cache);
      await engine.preloadFile(getVirtualFile(file), parsed.content);
    } catch (err) {
      console.error(`preload skip: ${file}`, err instanceof Error ? err.message : err);
    }
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
  };
}
