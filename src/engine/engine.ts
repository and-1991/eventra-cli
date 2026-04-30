import { TSService } from "./languageService";
import { ScanResult, scanSource } from "./scanner";
import { DependencyGraph } from "./graph";
import { hash } from "./hash";
import { EventraConfig } from "../types";
import { isExternalFile } from "./boundary";

export class EventraEngine {
  private ts: TSService;
  private graph: DependencyGraph;

  private fileResults = new Map<string, ScanResult>();
  private fileHash = new Map<string, string>();

  constructor(root: string) {
    this.ts = new TSService(root);

    const { baseUrl, paths } = this.ts.getModuleResolutionConfig();
    this.graph = new DependencyGraph(baseUrl, paths);
  }

  // SCAN FILE
  scanFile(
    file: string,
    content: string,
    config: EventraConfig
  ): ScanResult {
    const h = hash(content);
    const isWatch = process.env.EVENTRA_WATCH === "1";

    // skip unchanged
    if (this.fileHash.get(file) === h && !isWatch) {
      return (
        this.fileResults.get(file) ?? {
          events: new Set(),
          detectedFunctionWrappers: new Set(),
          detectedComponentWrappers: new Map(),
        }
      );
    }

    this.fileHash.set(file, h);
    this.ts.updateFile(file, content);

    const source = this.ts.getSourceFile(file);
    const checker = this.ts.getChecker();

    if (!source || !checker) {
      return {
        events: new Set(),
        detectedFunctionWrappers: new Set(),
        detectedComponentWrappers: new Map(),
      };
    }

    // update dependency graph
    this.graph.update(file, source);

    const res = scanSource(source, checker, config);

    this.fileResults.set(file, res);

    return res;
  }

  // UPDATE FILE (incremental)
  updateFile(
    file: string,
    content: string,
    config: EventraConfig
  ) {
    const res = this.scanFile(file, content, config);

    const dependents = this.graph.getAllDependentsDeep(file);

    for (const dep of dependents) {
      // skip external files
      if (isExternalFile(dep)) continue;

      const source = this.ts.getSourceFile(dep);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      const depContent = this.ts.getFileContent(dep);
      if (!depContent) continue;

      const h = hash(depContent);
      const isWatch = process.env.EVENTRA_WATCH === "1";

      // skip unchanged dependents
      if (this.fileHash.get(dep) === h && !isWatch) continue;

      this.fileHash.set(dep, h);

      this.graph.update(dep, source);

      const r = scanSource(source, checker, config);
      this.fileResults.set(dep, r);
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
    this.ts.removeFile(file);
    this.fileResults.delete(file);
    this.fileHash.delete(file);
    this.graph.remove(file);
    const dependents = this.graph.getAllDependentsDeep(file);

    for (const dep of dependents) {
      if (isExternalFile(dep)) continue;

      const source = this.ts.getSourceFile(dep);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      const content = this.ts.getFileContent(dep);
      if (!content) continue;

      const h = hash(content);
      const isWatch = process.env.EVENTRA_WATCH === "1";

      // skip unchanged
      if (this.fileHash.get(dep) === h && !isWatch) continue;

      this.fileHash.set(dep, h);

      const r = scanSource(
        source,
        checker,
        config ?? {
          events: [],
          wrappers: [],
          functionWrappers: [],
          sync: { include: [], exclude: [] },
        }
      );

      this.fileResults.set(dep, r);
    }
  }
}
