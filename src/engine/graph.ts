import { SourceFile } from "ts-morph";

export class DependencyGraph {
  private reverse = new Map<string, Set<string>>();

  update(file: string, source: SourceFile) {
    const imports = source
      .getImportDeclarations()
      .map(i => i.getModuleSpecifierSourceFile()?.getFilePath())
      .filter(Boolean) as string[];

    for (const dep of imports) {
      if (!this.reverse.has(dep)) {
        this.reverse.set(dep, new Set());
      }
      this.reverse.get(dep)!.add(file);
    }
  }

  getDependents(file: string) {
    return [...(this.reverse.get(file) ?? [])];
  }
}
