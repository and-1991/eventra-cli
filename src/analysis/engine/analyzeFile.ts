import ts from "typescript";

import { EventraConfig, ScanResult } from "../../types";
import { scanSource } from "../scanner/scanner";
import { extractEvents } from "../extractor/extractor";
import { FileSemanticIndex } from "../shared/types";
import { WrapperRegistry } from "../symbols/wrapperRegistry";
import { EvaluationCache } from "../cache/evaluationCache";
import { ResolvedCallCache } from "../cache/resolvedCallCache";
import { ReturnPropagationCache } from "../cache/returnPropagationCache";
import { ResolvedExportCache } from "../cache/resolvedExportCache";

export function indexSourceFile(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  wrapperRegistry: WrapperRegistry,
): FileSemanticIndex {
  return scanSource(source, checker, wrapperRegistry);
}

export function extractFromIndex(
  index: FileSemanticIndex,
  config: EventraConfig,
  checker: ts.TypeChecker,
  wrapperRegistry: WrapperRegistry,
  evaluationCache: EvaluationCache,
  resolvedCallCache: ResolvedCallCache,
  returnPropagationCache: ReturnPropagationCache,
  resolvedExportCache: ResolvedExportCache,
): ScanResult {
  return extractEvents(
    index,
    checker,
    config,
    evaluationCache,
    resolvedExportCache,
    resolvedCallCache,
    returnPropagationCache,
    wrapperRegistry,
  );
}
