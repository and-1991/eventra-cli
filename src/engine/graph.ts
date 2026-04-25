import ts from "typescript";

export class DependencyGraph {
  private reverse = new Map<string, Set<string>>();

  update(file: string, source: ts.SourceFile) {
    for (const stmt of source.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;

      const module = stmt.moduleSpecifier.getText().replace(/['"]/g, "");

      if (!this.reverse.has(module)) {
        this.reverse.set(module, new Set());
      }

      this.reverse.get(module)!.add(file);
    }
  }

  getDependents(file: string) {
    return [...(this.reverse.get(file) ?? [])];
  }
}
