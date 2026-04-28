import ts from "typescript";
import path from "path";
import fs from "fs";

export class DependencyGraph {
  private reverse = new Map<string, Set<string>>();
  private exports = new Map<string, Set<string>>();

  constructor(
    private baseUrl: string,
    private paths: Record<string, string[]>
  ) {}

  private normalize(file: string) {
    return path.resolve(file);
  }

  // TS-like resolver
  private resolveModule(module: string, from: string): string | null {
    // relative
    if (module.startsWith(".")) {
      const abs = path.resolve(path.dirname(from), module);
      return this.resolveFile(abs);
    }

    // paths mapping
    for (const key in this.paths) {
      const pattern = key.replace("*", "(.*)");
      const regex = new RegExp("^" + pattern + "$");
      const match = module.match(regex);

      if (!match) continue;

      const wildcard = match[1] || "";

      for (const target of this.paths[key]) {
        const replaced = target.replace("*", wildcard);
        const abs = path.resolve(this.baseUrl, replaced);

        const resolved = this.resolveFile(abs);
        if (resolved) return resolved;
      }
    }

    // baseUrl fallback
    const abs = path.resolve(this.baseUrl, module);
    const resolved = this.resolveFile(abs);
    if (resolved) return resolved;

    return null;
  }

  private resolveFile(base: string): string | null {
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

    return null;
  }

  update(file: string, source: ts.SourceFile) {
    const normalizedFile = this.normalize(file);

    this.exports.set(normalizedFile, new Set());

    for (const stmt of source.statements) {
      // IMPORT
      if (ts.isImportDeclaration(stmt)) {
        const module = stmt.moduleSpecifier.getText().replace(/['"]/g, "");

        const resolved = this.resolveModule(module, normalizedFile);
        if (!resolved) continue;

        if (!this.reverse.has(resolved)) {
          this.reverse.set(resolved, new Set());
        }

        this.reverse.get(resolved)!.add(normalizedFile);
      }

      // EXPORT *
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const module = stmt.moduleSpecifier.getText().replace(/['"]/g, "");

        const resolved = this.resolveModule(module, normalizedFile);
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
