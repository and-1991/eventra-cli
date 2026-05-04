import ts from "typescript";
import path from "path";
import fs from "fs";

export class DependencyGraph {
  private reverse = new Map<string, Set<string>>();
  private exports = new Map<string, Set<string>>();
  private fileCache = new Map<string, string | null>();

  constructor(
    private baseUrl: string,
    private paths: Record<string, string[]>
  ) {}

  private normalize(file: string) {
    return path.resolve(file).replace(/\\/g, "/");
  }

  // MODULE RESOLVE
  private resolveModule(module: string, from: string): string | null {
    // relative import
    if (module.startsWith(".")) {
      const abs = path.resolve(path.dirname(from), module);
      return this.resolveFile(abs);
    }

    // tsconfig paths
    for (const key in this.paths) {
      const pattern = key.replace(/\*/g, "(.*)");
      const regex = new RegExp("^" + pattern + "$");
      const match = module.match(regex);

      if (!match) continue;

      const wildcard = match.slice(1);

      for (const target of this.paths[key]) {
        let replaced = target;

        wildcard.forEach(w => {
          replaced = replaced.replace("*", w);
        });

        const abs = path.resolve(this.baseUrl, replaced);
        const resolved = this.resolveFile(abs);
        if (resolved) return resolved;
      }
    }

    // node resolution (safe)
    try {
      const resolved = require.resolve(module, {
        paths: [path.dirname(from)],
      });

      return this.normalize(resolved);
    } catch {}

    // fallback
    const abs = path.resolve(this.baseUrl, module);
    return this.resolveFile(abs);
  }

  // FILE RESOLVE
  private resolveFile(base: string): string | null {
    if (this.fileCache.has(base)) {
      return this.fileCache.get(base)!;
    }

    const tryFiles = [
      base,
      base + ".ts",
      base + ".tsx",
      base + ".js",
      base + ".jsx",
      base + ".mjs",
      base + ".cjs",
      base + ".d.ts",
      base + ".vue",
      base + ".svelte",
      base + ".astro",
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.js"),
    ];

    for (const f of tryFiles) {
      if (fs.existsSync(f)) {
        const normalized = this.normalize(f);
        this.fileCache.set(base, normalized);
        return normalized;
      }
    }

    this.fileCache.set(base, null);
    return null;
  }

  // UPDATE GRAPH
  update(file: string, source: ts.SourceFile) {
    const normalizedFile = this.normalize(file);

    for (const deps of this.reverse.values()) {
      deps.delete(normalizedFile);
    }

    this.exports.set(normalizedFile, new Set());

    for (const stmt of source.statements) {

      // IMPORT
      if (ts.isImportDeclaration(stmt)) {
        // ignore import type
        if ((stmt.importClause as any)?.importKind === "type") continue;

        const module = stmt.moduleSpecifier
          .getText()
          .replace(/['"]/g, "");

        const resolved = this.resolveModule(module, normalizedFile);
        if (!resolved) continue;

        if (!this.reverse.has(resolved)) {
          this.reverse.set(resolved, new Set());
        }

        this.reverse.get(resolved)!.add(normalizedFile);
      }

      // EXPORT (re-export)
      if (ts.isExportDeclaration(stmt)) {
        if (!stmt.moduleSpecifier) continue;

        const module = stmt.moduleSpecifier
          .getText()
          .replace(/['"]/g, "");

        const resolved = this.resolveModule(module, normalizedFile);
        if (!resolved) continue;

        this.exports.get(normalizedFile)?.add(resolved);

        if (!this.reverse.has(resolved)) {
          this.reverse.set(resolved, new Set());
        }

        this.reverse.get(resolved)!.add(normalizedFile);
      }
    }
  }

  // DEPENDENTS
  getAllDependentsDeep(file: string): string[] {
    const start = this.normalize(file);
    const visited = new Set<string>();
    const result = new Set<string>();

    const walk = (f: string) => {
      if (visited.has(f)) return;
      visited.add(f);

      const deps = this.reverse.get(f);
      deps?.forEach(d => {
        result.add(d);
        walk(d);
      });

      const ex = this.exports.get(f);
      ex?.forEach(e => walk(e));
    };

    walk(start);

    return [...result];
  }

  // REMOVE
  remove(file: string) {
    const normalized = this.normalize(file);

    this.reverse.delete(normalized);
    this.exports.delete(normalized);
    this.fileCache.delete(normalized);

    for (const set of this.reverse.values()) {
      set.delete(normalized);
    }

    for (const set of this.exports.values()) {
      set.delete(normalized);
    }
  }
}
