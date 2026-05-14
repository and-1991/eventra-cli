import fs from "fs";
import path from "path";
import ts from "typescript";

export interface DocumentRecord {
  readonly fileName: string;
  readonly content: string;
  readonly snapshot: ts.IScriptSnapshot;
  readonly version: number;
}

export class DocumentRegistry {
  private readonly documents = new Map<string, DocumentRecord>();

  normalize(fileName: string): string {
    return path.resolve(fileName).replace(/\\/g, "/");
  }

  has(fileName: string): boolean {
    return this.documents.has(this.normalize(fileName));
  }

  get(fileName: string): DocumentRecord | undefined {
    return this.documents.get(this.normalize(fileName));
  }

  getContent(fileName: string): string | undefined {
    return this.get(fileName)?.content;
  }

  getSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    return this.get(fileName)?.snapshot;
  }

  getVersion(fileName: string): string {
    return (this.get(fileName)?.version.toString() ?? "0");
  }

  update(fileName: string, content: string): void {
    const normalized = this.normalize(fileName);
    const existing = this.documents.get(normalized);
    if (existing && existing.content === content) {
      return;
    }
    this.documents.set(normalized, {
      fileName: normalized,
      content,
      version: existing ? existing.version + 1 : 1,
      snapshot: ts.ScriptSnapshot.fromString(content)
    });
  }

  ensure(fileName: string): void {
    const normalized = this.normalize(fileName);
    if (this.documents.has(normalized)) {
      return;
    }
    try {
      const content = fs.readFileSync(normalized, "utf8");
      this.update(normalized, content);
    } catch {
      // ignore missing files
    }
  }

  remove(fileName: string): void {
    this.documents.delete(this.normalize(fileName));
  }

  getFileNames(): string[] {
    return [
      ...this.documents.keys()
    ];
  }

  invalidate(): void {
    this.documents.clear();
  }
}
