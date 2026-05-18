import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";

import { EventraConfig, ScanResult } from "../types";
import { EventraEngine } from "./EventraEngine";
import { processFile } from "../filesystem/processFile";
import { getVirtualFile } from "../filesystem/getVirtualFile";

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
  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  const engine = new EventraEngine(process.cwd());
  const cache = new Map<string, CachedFile>();
  const toScan = new Set<string>();

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf8");
      if (raw.length > 2_000_000) continue;

      const parsed = await processFile(file, raw);
      cache.set(file, parsed);
      toScan.add(file);
      for (const dep of parsed.dependencies) {
        toScan.add(path.resolve(path.dirname(file), dep));
      }
    } catch (err) {
      console.error(`skip: ${file}`, err instanceof Error ? err.message : err);
    }
  }

  const virtualFiles = [...toScan].map((f) => getVirtualFile(f));

  engine.beginPreload();
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
