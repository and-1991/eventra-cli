import { TSService } from "./languageService";
import { scanSource } from "./scanner";
import { DependencyGraph } from "./graph";
import { hash } from "./hash";

export class EventraEngine {
  private ts: TSService;
  private graph: DependencyGraph;

  private fileEvents = new Map<string, Set<string>>();
  private fileHash = new Map<string, string>();

  constructor(root: string) {
    this.ts = new TSService(root);

    const { baseUrl, paths } = this.ts.getModuleResolutionConfig();
    this.graph = new DependencyGraph(baseUrl, paths);
  }

  scanFile(file: string, content: string) {
    const h = hash(content);

    // cache
    if (this.fileHash.get(file) === h) {
      return this.fileEvents.get(file) ?? new Set();
    }

    this.fileHash.set(file, h);

    this.ts.updateFile(file, content);

    const source = this.ts.getSourceFile(file);
    const checker = this.ts.getChecker();

    if (!source || !checker) return new Set();

    // обновляем graph
    this.graph.update(file, source);

    const events = scanSource(source, checker);

    this.fileEvents.set(file, events);

    return events;
  }

  updateFile(file: string, content: string) {
    const events = this.scanFile(file, content);

    const dependents = this.graph.getDependents(file);

    for (const dep of dependents) {
      const source = this.ts.getSourceFile(dep);
      const checker = this.ts.getChecker();

      if (!source || !checker) continue;

      const ev = scanSource(source, checker);

      this.fileEvents.set(dep, ev);
    }

    return events;
  }

  getAllEvents() {
    const all = new Set<string>();

    for (const set of this.fileEvents.values()) {
      set.forEach(e => all.add(e));
    }

    return [...all];
  }

  removeFile(file: string) {
    this.fileEvents.delete(file);
    this.fileHash.delete(file);
    this.graph.remove(file);
  }
}
