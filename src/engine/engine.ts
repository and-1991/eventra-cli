import path from "path";
import fs from "fs";

import { TSService } from "./languageService";
import { scanSource } from "./scanner";
import { DependencyGraph } from "./graph";
import { hash } from "./hash";
import { EventraConfig, ScanResult } from "../types";
import { isExternalFile } from "./boundary";

export class EventraEngine {
  private ts: TSService;
  private graph: DependencyGraph;
  private wrapperCache = new Map<string, string | null>();
  private fileResults = new Map<string, ScanResult>();
  private fileHash = new Map<string, string>();

  constructor(root: string) {
    this.ts = new TSService(root);

    const { baseUrl, paths } = this.ts.getModuleResolutionConfig();
    this.graph = new DependencyGraph(baseUrl, paths);
  }

  private normalize(file: string) {
    return path.resolve(file).replace(/\\/g, "/");
  }

  private empty(): ScanResult {
    return {
      events: new Set(),
      detectedFunctionWrappers: new Set(),
      detectedComponentWrappers: new Map(),
    };
  }

  // PRELOAD
  preloadFile(file: string, content: string) {
    file = this.normalize(file);

    this.ts.updateFile(file, content);

    const source = this.ts.getSourceFile(file);
    if (source) {
      this.graph.update(file, source);
    }
  }

  // SCAN FILE (cached)
  scanFile(
    file: string,
    content: string,
    config: EventraConfig
  ): ScanResult {
    file = this.normalize(file);

    const h = hash(content);

    if (this.fileHash.get(file) === h) {
      return this.fileResults.get(file) ?? this.empty();
    }

    this.fileHash.set(file, h);

    this.ts.updateFile(file, content);

    const source = this.ts.getSourceFile(file);
    const checker = this.ts.getChecker();

    if (!source || !checker) {
      return this.empty();
    }

    this.graph.update(file, source);

    const res = scanSource(
      source,
      checker,
      config,
      new Set(),
      undefined,
      this.wrapperCache
    );

    this.fileResults.set(file, res);

    return res;
  }

  // UPDATE FILE (incremental)
  updateFile(
    file: string,
    content: string,
    config: EventraConfig
  ): ScanResult {
    file = this.normalize(file);

    // EARLY EXIT
    if (this.fileHash.get(file) === hash(content)) {
      return this.fileResults.get(file) ?? this.empty();
    }

    // invalidate wrapper cache
    this.wrapperCache.clear();

    const res = this.scanFile(file, content, config);

    const dependents = this.graph.getAllDependentsDeep(file);

    for (const dep of dependents) {
      const abs = this.normalize(dep);

      if (abs === file) continue; // self-skip
      if (isExternalFile(abs)) continue;

      let depContent = this.ts.getFileContent(abs);

      if (!depContent) {
        try {
          depContent = fs.readFileSync(abs, "utf-8");
        } catch {
          continue;
        }
      }

      const h = hash(depContent);

      if (this.fileHash.get(abs) === h) {
        continue;
      }

      this.fileHash.set(abs, h);

      this.ts.updateFile(abs, depContent);

      const source = this.ts.getSourceFile(abs);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      this.graph.update(abs, source);

      const r = scanSource(
        source,
        checker,
        config,
        new Set(),
        undefined,
        this.wrapperCache
      );

      this.fileResults.set(abs, r);
    }

    return res;
  }

  // GET ALL EVENTS
  getAllEvents() {
    const all = new Set<string>();

    for (const r of this.fileResults.values()) {
      r.events.forEach(e => all.add(e));
    }

    return [...all];
  }

  // REMOVE FILE
  removeFile(file: string, config?: EventraConfig) {
    file = this.normalize(file);

    this.wrapperCache.clear();

    const dependents = this.graph.getAllDependentsDeep(file);

    this.graph.remove(file);

    this.ts.removeFile(file);
    this.fileResults.delete(file);
    this.fileHash.delete(file);

    for (const dep of dependents) {
      const abs = this.normalize(dep);

      if (abs === file) continue;
      if (isExternalFile(abs)) continue;

      let content = this.ts.getFileContent(abs);

      if (!content) {
        try {
          content = fs.readFileSync(abs, "utf-8");
        } catch {
          continue;
        }
      }

      this.fileHash.delete(abs);

      this.ts.updateFile(abs, content);

      const source = this.ts.getSourceFile(abs);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      this.graph.update(abs, source);

      const r = scanSource(
        source,
        checker,
        config ?? {
          events: [],
          wrappers: [],
          functionWrappers: [],
          sync: { include: [], exclude: [] },
        },
        new Set(),
        undefined,
        this.wrapperCache
      );

      this.fileResults.set(abs, r);
    }
  }
}
