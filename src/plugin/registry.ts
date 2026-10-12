import path from "path";

import type {
  DynamicEventReporter,
  FilePreprocessor,
  FilePreprocessInput,
  SinkDetector,
  SinkDetectorContext,
  VirtualFile,
  WrapperDetector,
  WrapperDetectorContext,
} from "./types";
import type { DynamicOccurrence } from "../analysis/shared/dynamicOccurrence";

// the synthetic callee each framework plugin uses for a template `event=...`
const TEMPLATE_CALLEE = /^__eventra_[a-z]+_template_event__$/;

// `__eventra_x_template_event__(expr)` (callText may be cut with an ellipsis)
function templateExpression(occurrence: DynamicOccurrence): string {
  const open = occurrence.callText.indexOf("(");
  let expression = open === -1 ? occurrence.callText : occurrence.callText.slice(open + 1);
  expression = expression.endsWith(")") ? expression.slice(0, -1) : expression;
  // Angular qualifies a bare name with `this.`; the template never writes it
  return occurrence.calleeText.includes("_angular_") ? expression.replace(/^this\./, "") : expression;
}

export class PluginRegistry {
  private readonly preprocessors: FilePreprocessor[] = [];
  private readonly sinkDetectors: SinkDetector[] = [];
  private readonly wrapperDetectors: WrapperDetector[] = [];
  private readonly dynamicEventReporters: DynamicEventReporter[] = [];
  private readonly includePatterns: string[] = [];
  private readonly sourceToVirtuals = new Map<string, string[]>();

  registerFilePreprocessor(preprocessor: FilePreprocessor): void {
    if (this.preprocessors.some((p) => p.name === preprocessor.name)) {
      throw new Error(`File preprocessor already registered: ${preprocessor.name}`);
    }
    this.preprocessors.push(preprocessor);
  }

  registerSinkDetector(detector: SinkDetector): void {
    if (this.sinkDetectors.some((d) => d.name === detector.name)) {
      throw new Error(`Sink detector already registered: ${detector.name}`);
    }
    this.sinkDetectors.push(detector);
  }

  registerWrapperDetector(detector: WrapperDetector): void {
    if (this.wrapperDetectors.some((d) => d.name === detector.name)) {
      throw new Error(`Wrapper detector already registered: ${detector.name}`);
    }
    this.wrapperDetectors.push(detector);
  }

  registerDynamicEventReporter(reporter: DynamicEventReporter): void {
    if (this.dynamicEventReporters.some((r) => r.name === reporter.name)) {
      throw new Error(`Dynamic event reporter already registered: ${reporter.name}`);
    }
    this.dynamicEventReporters.push(reporter);
  }

  registerIncludePattern(pattern: string): void {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    if (this.includePatterns.includes(trimmed)) return;
    this.includePatterns.push(trimmed);
  }

  getIncludePatterns(): readonly string[] {
    return this.includePatterns;
  }

  getSinkDetectors(): readonly SinkDetector[] {
    return this.sinkDetectors;
  }

  getWrapperDetectors(): readonly WrapperDetector[] {
    return this.wrapperDetectors;
  }

  getDynamicEventReporters(): readonly DynamicEventReporter[] {
    return this.dynamicEventReporters;
  }

  getFilePreprocessors(): readonly FilePreprocessor[] {
    return this.preprocessors;
  }

  /** Disk paths produced by the last preprocess run for a source file (for watch unlink). */
  getVirtualPathsForSource(fileName: string): readonly string[] {
    const mapped = this.sourceToVirtuals.get(this.normalizePath(fileName));
    if (mapped && mapped.length > 0) {
      return mapped;
    }
    return [this.normalizePath(fileName)];
  }

  async preprocessFile(input: FilePreprocessInput): Promise<readonly VirtualFile[]> {
    const sourceKey = this.normalizePath(input.fileName);

    for (const preprocessor of this.preprocessors) {
      if (!preprocessor.test(input.fileName)) {
        continue;
      }
      const files = await preprocessor.process(input);
      if (files.length > 0) {
        this.sourceToVirtuals.set(
          sourceKey,
          files.map((file) => this.normalizePath(file.fileName)),
        );
        return files;
      }
    }

    this.sourceToVirtuals.delete(sourceKey);
    return [{ fileName: input.fileName, content: input.content }];
  }

  detectSink(context: SinkDetectorContext) {
    for (const detector of this.sinkDetectors) {
      const sink = detector.detect(context);
      if (sink) {
        return sink;
      }
    }
    return null;
  }

  detectWrapper(context: WrapperDetectorContext) {
    for (const detector of this.wrapperDetectors) {
      const wrapper = detector.detect(context);
      if (wrapper) {
        return wrapper;
      }
    }
    return null;
  }

  async runDynamicEventReporters(occurrences: readonly DynamicOccurrence[]): Promise<void> {
    const attributed = this.attributeToSources(occurrences);
    for (const reporter of this.dynamicEventReporters) {
      await reporter.report({ occurrences: attributed });
    }
  }

  /**
   * Occurrences are found in virtual modules (`App.vue.ts`). Point them back
   * at the file the user wrote, and flag the ones that come from generated
   * code so reporters do not print a line number that exists nowhere.
   */
  private attributeToSources(occurrences: readonly DynamicOccurrence[]): readonly DynamicOccurrence[] {
    if (this.sourceToVirtuals.size === 0) {
      return occurrences;
    }
    const virtualToSource = new Map<string, string>();
    for (const [source, virtuals] of this.sourceToVirtuals) {
      for (const virtual of virtuals) {
        if (virtual !== source) {
          virtualToSource.set(virtual, source);
        }
      }
    }
    return occurrences.map((occurrence) => {
      const source = virtualToSource.get(this.normalizePath(occurrence.fileName));
      if (!source) {
        return occurrence;
      }
      const template = TEMPLATE_CALLEE.test(occurrence.calleeText);
      if (template) {
        return {
          ...occurrence,
          fileName: source,
          inTemplate: true,
          eventExpression: templateExpression(occurrence),
        };
      }
      // an Angular template module embeds the component class: lines there
      // are generated, the real call is also reported from the class file
      return source.toLowerCase().endsWith(".html")
        ? { ...occurrence, fileName: source, inGeneratedCode: true }
        : { ...occurrence, fileName: source };
    });
  }

  private normalizePath(fileName: string): string {
    return path.resolve(fileName).replace(/\\/g, "/");
  }
}
