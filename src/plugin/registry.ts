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
    for (const reporter of this.dynamicEventReporters) {
      await reporter.report({ occurrences });
    }
  }

  private normalizePath(fileName: string): string {
    return path.resolve(fileName).replace(/\\/g, "/");
  }
}
