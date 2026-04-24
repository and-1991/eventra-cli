import { ProjectGraph } from "./project";
import { scanSource } from "./scanner";

export class EventraEngine {
  private project: ProjectGraph;
  private fileEvents = new Map<string, Set<string>>();

  constructor(entry: string) {
    this.project = new ProjectGraph(entry);
  }

  scanFile(file: string, content: string) {
    const source = this.project.getSource(file, content);
    const checker = this.project.getChecker();

    const events = scanSource(source, checker);

    this.fileEvents.set(file, events);
    return events;
  }

  updateFile(file: string, content: string) {
    return this.scanFile(file, content);
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
  }
}
