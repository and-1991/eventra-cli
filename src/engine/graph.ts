import ts from "typescript";
import path from "path";
import fs from "fs";

export class DependencyGraph {
  private reverse = new Map<string, Set<string>>();
  private exports = new Map<string, Set<string>>();

  private normalize(file: string) {
    return path.resolve(file);
  }

  private resolveImport(from: string, module: string): string | null {
    if (!module.startsWith(".")) return null;

    const base = path.resolve(path.dirname(from), module);

    const tryFiles = [
      base,
      base + ".ts",
      base + ".tsx",
      base + ".js",
      base + ".jsx",
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.js"),
    ];

    for (const f of tryFiles) {
      if (fs.existsSync(f)) {
        return this.normalize(f);
      }
    }

    return this.normalize(base);
  }

  update(file: string, source: ts.SourceFile) {
    const normalizedFile = this.normalize(file);

    this.exports.set(normalizedFile, new Set());

    for (const stmt of source.statements) {
      // IMPORT
      if (ts.isImportDeclaration(stmt)) {
        const module = stmt.moduleSpecifier.getText().replace(/['"]/g, "");
        const resolved = this.resolveImport(normalizedFile, module);

        if (!resolved) continue;

        if (!this.reverse.has(resolved)) {
          this.reverse.set(resolved, new Set());
        }

        this.reverse.get(resolved)!.add(normalizedFile);
      }

      // EXPORT
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const module = stmt.moduleSpecifier.getText().replace(/['"]/g, "");
        const resolved = this.resolveImport(normalizedFile, module);

        if (!resolved) continue;

        if (!this.exports.has(normalizedFile)) {
          this.exports.set(normalizedFile, new Set());
        }

        this.exports.get(normalizedFile)!.add(resolved);

        if (!this.reverse.has(resolved)) {
          this.reverse.set(resolved, new Set());
        }

        this.reverse.get(resolved)!.add(normalizedFile);
      }
    }
  }

  getAllRelated(file: string, visited = new Set<string>()): Set<string> {
    const normalized = this.normalize(file);

    if (visited.has(normalized)) return visited;
    visited.add(normalized);

    const deps = this.exports.get(normalized);

    if (!deps) return visited;

    for (const dep of deps) {
      this.getAllRelated(dep, visited);
    }

    return visited;
  }

  getDependents(file: string) {
    return [...(this.reverse.get(this.normalize(file)) ?? [])];
  }

  remove(file: string) {
    const normalized = this.normalize(file);

    this.exports.delete(normalized);

    for (const set of this.reverse.values()) {
      set.delete(normalized);
    }
  }
}
