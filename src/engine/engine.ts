import { TSService } from "./languageService";
import { ScanResult, scanSource } from "./scanner";
import { DependencyGraph } from "./graph";
import { hash } from "./hash";
import { EventraConfig } from "../types";

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

  scanFile(file: string, content: string, config: EventraConfig): ScanResult {
    const h = hash(content);

    if (this.fileHash.get(file) === h) {
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

    this.graph.update(file, source);

    const res = scanSource(source, checker, config);

    this.fileResults.set(file, res);

    return res;
  }

  updateFile(file: string, content: string, config: EventraConfig) {
    const res = this.scanFile(file, content, config);

    const dependents = this.graph.getAllDependentsDeep(file);

    for (const dep of dependents) {
      const source = this.ts.getSourceFile(dep);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      const r = scanSource(source, checker, config);
      this.fileResults.set(dep, r);
    }

    return res;
  }

  getAllEvents() {
    const all = new Set<string>();

    for (const r of this.fileResults.values()) {
      r.events.forEach(e => all.add(e));
    }

    return [...all];
  }

  removeFile(file: string) {
    this.fileResults.delete(file);
    this.fileHash.delete(file);
    this.graph.remove(file);
  }
}
