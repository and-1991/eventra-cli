import ts from "typescript";

import {
  FileSemanticIndex,
} from "../shared/types";

export interface SemanticPass {

  run(
    source:
    ts.SourceFile,

    index:
    FileSemanticIndex,

    checker:
    ts.TypeChecker,
  ): void;
}
