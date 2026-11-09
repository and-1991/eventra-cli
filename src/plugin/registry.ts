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

// A plugin starts the code it generates from a template with this comment line, so a call found
// below it is not on a line the user wrote.
const TEMPLATE_REGION_START = /^\s*\/\/ --- [a-z]+ template \(auto-generated\) ---$/;
// optional: a module that carries more after the generated code (an Angular component class) ends it
const TEMPLATE_REGION_END = /^\s*\/\/ --- end template ---$/;

interface TemplateRegion {
  readonly from: number;
  readonly to: number;
}

// 1-based lines of every generated template region in a virtual module (a file with several Angular components has one
// per component), none when it has none
function templateRegionsOf(content: string): TemplateRegion[] {
  const lines = content.split("\n");
  const regions: TemplateRegion[] = [];
  let from = -1;
  lines.forEach((line, index) => {
    if (from === -1 && TEMPLATE_REGION_START.test(line)) from = index;
    else if (from !== -1 && TEMPLATE_REGION_END.test(line)) {
      regions.push({ from: from + 1, to: index + 1 });
      from = -1;
    }
  });
  // a region that is never ended runs to the end of the module
  if (from !== -1) regions.push({ from: from + 1, to: Infinity });
  return regions;
}

const inRegion = (regions: readonly TemplateRegion[] | undefined, line: number): boolean =>
  regions !== undefined && regions.some((region) => line >= region.from && line <= region.to);

// `__eventra_x_template_event__(expr)` (callText may be cut with an ellipsis)
function templateExpression(occurrence: DynamicOccurrence): string {
  // no "(" gives indexOf -1, so slice(0) keeps the whole text
  const afterOpen = occurrence.callText.slice(occurrence.callText.indexOf("(") + 1);
  const expression = afterOpen.endsWith(")") ? afterOpen.slice(0, -1) : afterOpen;
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
  // what plugins said about a file that is not an error, by file; replaced each time the file is transformed
  private readonly pluginNotes = new Map<string, readonly string[]>();
  private readonly partialFiles = new Map<string, readonly string[]>();
  private readonly dependenciesOf = new Map<string, readonly string[]>();
  private readonly templateRegions = new Map<string, readonly TemplateRegion[]>();

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
    // a source is only recorded with at least one virtual file, so a hit is never empty
    return this.sourceToVirtuals.get(this.normalizePath(fileName)) ?? [this.normalizePath(fileName)];
  }

  /** Records (or, when empty, forgets) what a plugin has to say about a source file. */
  setPluginNotes(fileName: string, notes: readonly string[]): void {
    const key = this.normalizePath(fileName);
    if (notes.length > 0) this.pluginNotes.set(key, notes);
    else this.pluginNotes.delete(key);
  }

  /** Records (or, when empty, forgets) why a source file was read only in part. */
  setPartial(fileName: string, reasons: readonly string[]): void {
    const key = this.normalizePath(fileName);
    if (reasons.length > 0) this.partialFiles.set(key, reasons);
    else this.partialFiles.delete(key);
  }

  /** The files a plugin read only in part, as `{ file, reason }`. */
  getPartialFiles(): { file: string; reason: string }[] {
    return [...this.partialFiles].flatMap(([file, reasons]) => reasons.map((reason) => ({ file, reason })));
  }

  /** Records (or, when empty, forgets) the other files a source's generated modules were built from. */
  setDependencies(fileName: string, dependencies: readonly string[]): void {
    const key = this.normalizePath(fileName);
    if (dependencies.length > 0) this.dependenciesOf.set(key, dependencies.map((dependency) => this.normalizePath(dependency)));
    else this.dependenciesOf.delete(key);
  }

  /** The source files whose generated modules were built from `file`: they are stale when it changes. */
  dependentsOf(file: string): string[] {
    const key = this.normalizePath(file);
    return [...this.dependenciesOf].filter(([, dependencies]) => dependencies.includes(key)).map(([source]) => source);
  }

  /** Every note a plugin left about a file, as `{ file, reason }`, in the order the files were read. */
  getPluginNotes(): { file: string; reason: string }[] {
    return [...this.pluginNotes].flatMap(([file, notes]) => notes.map((reason) => ({ file, reason })));
  }

  async preprocessFile(input: FilePreprocessInput): Promise<readonly VirtualFile[]> {
    const sourceKey = this.normalizePath(input.fileName);

    for (const preprocessor of this.preprocessors) {
      if (!preprocessor.test(input.fileName)) {
        continue;
      }
      const files = await preprocessor.process(input);
      if (files.length > 0) {
        // virtual files this source produced before and no longer does: their regions are not valid for anything else
        for (const stale of this.sourceToVirtuals.get(sourceKey) ?? []) this.templateRegions.delete(stale);
        for (const file of files) {
          const key = this.normalizePath(file.fileName);
          const regions = templateRegionsOf(file.content);
          if (regions.length === 0) this.templateRegions.delete(key);
          else this.templateRegions.set(key, regions);
        }
        this.sourceToVirtuals.set(
          sourceKey,
          files.map((file) => this.normalizePath(file.fileName)),
        );
        return files;
      }
    }

    for (const stale of this.sourceToVirtuals.get(sourceKey) ?? []) this.templateRegions.delete(stale);
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
  /**
   * Whether `line` of a plugin's generated module is code the user wrote (a script), not code the plugin
   * generated from a template. A syntax error on such a line is the user's.
   */
  isUserWrittenLine(virtualFile: string, line: number): boolean {
    return !inRegion(this.templateRegions.get(this.normalizePath(virtualFile)), line);
  }

  /** The file the user wrote that a generated (virtual) file came from, or undefined for a plain file. */
  getSourceForVirtual(virtualFile: string): string | undefined {
    const key = this.normalizePath(virtualFile);
    for (const [source, virtuals] of this.sourceToVirtuals) {
      if (source !== key && virtuals.includes(key)) return source;
    }
    return undefined;
  }

  attributeToSources<T extends DynamicOccurrence>(occurrences: readonly T[]): readonly T[] {
    if (this.sourceToVirtuals.size === 0) {
      return occurrences;
    }
    const virtualToSource = new Map<string, string>();
    for (const [source, virtuals] of this.sourceToVirtuals) {
      for (const virtual of virtuals) {
        // A module that IS the file (an Angular component with an inline template: the template's calls are
        // spliced into the real class) is attributed too when it holds generated code, so such a call is
        // shown as "template of <file>" and not at a line that is not in the file.
        if (virtual !== source || this.templateRegions.has(virtual)) {
          virtualToSource.set(virtual, source);
        }
      }
    }
    return occurrences.map((occurrence) => {
      const key = this.normalizePath(occurrence.fileName);
      const source = virtualToSource.get(key) ?? (TEMPLATE_CALLEE.test(occurrence.calleeText) && this.sourceToVirtuals.has(key) ? key : undefined);
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
      // ordinary code the plugin copied out of the template: its line is in the generated text
      if (inRegion(this.templateRegions.get(this.normalizePath(occurrence.fileName)), occurrence.line)) {
        return { ...occurrence, fileName: source, inTemplateCode: true };
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
