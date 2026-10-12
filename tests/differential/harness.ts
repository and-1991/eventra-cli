import fs from "fs";
import os from "os";
import path from "path";

import { scanProject } from "../../src/core/projectScanner";
import { getVirtualFile } from "../../src/filesystem/getVirtualFile";
import type { EventraEngine } from "../../src/core/EventraEngine";
import type { PluginRegistry } from "../../src/plugin/registry";
import type { EventraConfig } from "../../src/types";

// Differential test for the incremental engine.
//
// A random project is edited step by step (create, delete, rename, modify,
// break and fix files, in sequential and in concurrent batches, the way `watch`
// does it). After EVERY step the incrementally updated engine must report
// exactly what a brand new engine reports when it scans the same files from
// scratch: per file events, wrappers and dynamic occurrences.

// ---------- seeded random ----------

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  }

  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

// ---------- file model ----------

type WrapperForm = "function" | "arrow" | "prefix" | "chain" | "none";

interface WrapperSpec {
  readonly name: string;
  readonly form: WrapperForm;
  // chain: calls this other wrapper (by file and name) with its argument
  readonly chainTo?: { readonly file: string; readonly name: string };
  readonly literal?: string;
}

interface CallSpec {
  readonly kind: "wrapper" | "direct" | "directConst" | "dynamic" | "ternary" | "template";
  readonly from?: string; // file the wrapper is imported from
  readonly name?: string; // wrapper name
  readonly event: string;
  readonly other: string;
}

interface FileSpec {
  readonly kind: "lib" | "caller" | "barrel" | "script";
  // keep importing a target that does not exist (yet): the importer's text then
  // never changes when the target appears or vanishes, like real code
  readonly alwaysImport?: boolean;
  readonly extras?: readonly ("dynImport" | "require" | "declareGlobal")[];
  readonly wrappers: readonly WrapperSpec[];
  readonly calls: readonly CallSpec[];
  readonly reexports: readonly { readonly from: string; readonly star: boolean; readonly name?: string; readonly alias?: string }[];
  readonly broken?: "truncate" | "garbage" | "badImport";
  readonly marker: number;
}

const HEADER = `import { Eventra } from "@eventra_dev/eventra-sdk";\nconst sdk = new Eventra({ apiKey: "k" });\n`;

function importPath(fromFile: string, toFile: string): string {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.ts$/, "");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function renderWrapper(w: WrapperSpec, file: string, specs: ReadonlyMap<string, FileSpec>): string {
  switch (w.form) {
    case "function":
      return `export function ${w.name}(name: string) { sdk.track(name); }\n`;
    case "arrow":
      return `export const ${w.name} = (name: string) => sdk.track(name);\n`;
    case "prefix":
      return `export function ${w.name}(name: string) { sdk.track("pre." + name); }\n`;
    case "chain": {
      if (w.chainTo && specs.has(w.chainTo.file)) {
        return `import { ${w.chainTo.name} as inner_${w.name} } from "${importPath(file, w.chainTo.file)}";\nexport function ${w.name}(name: string) { inner_${w.name}(name); }\n`;
      }
      return `export function ${w.name}(name: string) { void name; }\n`;
    }
    case "none":
      return `export function ${w.name}(name: string) { return name; }\n`;
  }
}

export function render(file: string, spec: FileSpec, specs: ReadonlyMap<string, FileSpec>): string {
  let out = `// marker ${spec.marker}\n`;
  if (spec.kind === "script") {
    // not a module: its function is a global, visible to every other script
    out += `function gscript${spec.marker % 7}(name: string) { return name; }\n`;
    if (spec.broken === "garbage") out += "\nconst = ;;; } ) => {{\n";
    return out;
  }
  if (spec.kind === "barrel") {
    for (const r of spec.reexports) {
      if (!specs.has(r.from) && spec.broken !== "badImport" && !spec.alwaysImport) continue;
      out += r.star
        ? `export * from "${importPath(file, r.from)}";\n`
        : `export { ${r.name} as ${r.alias} } from "${importPath(file, r.from)}";\n`;
    }
  } else {
    out += HEADER;
    for (const w of spec.wrappers) out += renderWrapper(w, file, specs);
    const imported = new Set<string>();
    const lines: string[] = [];
    for (const call of spec.calls) {
      switch (call.kind) {
        case "wrapper": {
          const target = call.from!;
          if (specs.has(target) || spec.broken === "badImport" || spec.alwaysImport) {
            const key = `${target}::${call.name}`;
            if (!imported.has(key)) {
              imported.add(key);
              out += `import { ${call.name} as ${call.name}_${imported.size} } from "${importPath(file, target)}";\n`;
            }
            const alias = `${call.name}_${[...imported].indexOf(key) + 1}`;
            lines.push(`${alias}("${call.event}");`);
          }
          break;
        }
        case "direct":
          lines.push(`sdk.track("${call.event}");`);
          break;
        case "directConst":
          lines.push(`const c_${call.other} = "${call.event}";\nsdk.track(c_${call.other});`);
          break;
        case "dynamic":
          lines.push(`export function dyn_${call.other}(v: string) { sdk.track(v); }\nsdk.track(String(Math.random()));`);
          break;
        case "ternary":
          lines.push(`sdk.track(Math.random() > 0.5 ? "${call.event}" : "${call.other}");`);
          break;
        case "template":
          lines.push(`const k_${call.other} = "${call.event}";\nsdk.track(\`\${k_${call.other}}.suffix\`);`);
          break;
      }
    }
    out += lines.join("\n") + (lines.length ? "\n" : "");
    for (const extra of spec.extras ?? []) {
      const lib = [...specs].find(([f, sp]) => sp.kind === "lib" && f !== file)?.[0];
      if (extra === "dynImport" && lib) {
        out += `export async function dynLoad${spec.marker}() { const m = await import("${importPath(file, lib)}"); return m; }\n`;
      } else if (extra === "require" && lib) {
        out += `declare function require(id: string): any;\nconst req${spec.marker} = require("${importPath(file, lib)}");\nvoid req${spec.marker};\n`;
      } else if (extra === "declareGlobal") {
        out += `declare global { interface Window { ev${spec.marker}: number } }\n`;
      }
    }
  }

  if (spec.broken === "truncate") {
    out = out.slice(0, Math.max(10, Math.floor(out.length * 0.6)));
  } else if (spec.broken === "garbage") {
    out += "\nconst = ;;; } ) => {{\n";
  }
  return out;
}

// ---------- project generation and edits ----------

const EVENT_POOL = ["a", "b", "c", "d", "e", "f", "g", "h"];

class Project {
  readonly specs = new Map<string, FileSpec>();
  private readonly graveyard = new Map<string, FileSpec>();
  private nextId = 0;
  private marker = 0;

  constructor(private readonly rng: Rng, private readonly dirs: readonly string[]) {}

  private newPath(kind: FileSpec["kind"]): string {
    const dir = this.rng.pick(this.dirs);
    const prefix = kind === "lib" ? "lib" : kind === "barrel" ? "barrel" : kind === "script" ? "scr" : "feat";
    return `${dir}${prefix}${this.nextId++}.ts`;
  }

  private event(): string {
    return `${this.rng.pick(EVENT_POOL)}.${this.rng.int(6)}`;
  }

  // flags that make an importer's text independent of what exists on disk, and
  // rare constructs the engine cannot follow through its import graph
  private flags(): Pick<FileSpec, "alwaysImport" | "extras"> {
    const extras: ("dynImport" | "require" | "declareGlobal")[] = [];
    if (this.rng.chance(0.08)) extras.push("dynImport");
    if (this.rng.chance(0.06)) extras.push("require");
    if (this.rng.chance(0.05)) extras.push("declareGlobal");
    return { alwaysImport: this.rng.chance(0.3), extras };
  }

  private libs(): string[] {
    return [...this.specs].filter(([, s]) => s.kind === "lib").map(([f]) => f);
  }

  private wrappersOf(file: string): WrapperSpec[] {
    const spec = this.specs.get(file);
    return spec ? spec.wrappers.filter((w) => w.form !== "none") : [];
  }

  private randomWrapper(): WrapperSpec {
    const forms: WrapperForm[] = ["function", "function", "arrow", "prefix", "chain", "none"];
    const form = this.rng.pick(forms);
    const name = `w${this.rng.int(40)}`;
    if (form === "chain") {
      const libs = this.libs();
      const target = libs.length ? this.rng.pick(libs) : undefined;
      const inner = target ? this.rng.pick(this.wrappersOf(target)) : undefined;
      if (target && inner) return { name, form, chainTo: { file: target, name: inner.name } };
      return { name, form: "function" };
    }
    return { name, form };
  }

  private randomCall(): CallSpec {
    const kind = this.rng.pick(["wrapper", "wrapper", "wrapper", "direct", "directConst", "dynamic", "ternary", "template"] as const);
    const event = this.event();
    const other = `${this.rng.int(1000)}`;
    if (kind === "wrapper") {
      const libs = this.libs();
      const from = libs.length ? this.rng.pick(libs) : undefined;
      const ws = from ? this.wrappersOf(from) : [];
      if (from && ws.length) {
        return { kind, from, name: this.rng.pick(ws).name, event, other };
      }
      return { kind: "direct", event, other };
    }
    return { kind, event, other };
  }

  makeSpec(kind: FileSpec["kind"]): FileSpec {
    const marker = this.marker++;
    if (kind === "lib") {
      const count = 1 + this.rng.int(3);
      const wrappers: WrapperSpec[] = [];
      const used = new Set<string>();
      for (let i = 0; i < count; i++) {
        const w = this.randomWrapper();
        if (used.has(w.name)) continue;
        used.add(w.name);
        wrappers.push(w);
      }
      return { kind, wrappers, calls: this.rng.chance(0.3) ? [this.randomCall()] : [], reexports: [], marker, ...this.flags() };
    }
    if (kind === "script") {
      return { kind, wrappers: [], calls: [], reexports: [], marker };
    }
    if (kind === "barrel") {
      const libs = this.libs();
      const reexports = [];
      for (let i = 0; i < 1 + this.rng.int(2); i++) {
        if (!libs.length) break;
        const from = this.rng.pick(libs);
        const ws = this.wrappersOf(from);
        if (this.rng.chance(0.5) || !ws.length) reexports.push({ from, star: true });
        else reexports.push({ from, star: false, name: this.rng.pick(ws).name, alias: `al${this.rng.int(30)}` });
      }
      return { kind, wrappers: [], calls: [], reexports, marker };
    }
    const calls: CallSpec[] = [];
    for (let i = 0; i < 1 + this.rng.int(4); i++) calls.push(this.randomCall());
    return { kind, wrappers: [], calls, reexports: [], marker, ...this.flags() };
  }

  create(kind?: FileSpec["kind"]): string {
    const k = kind ?? this.rng.pick(["lib", "caller", "caller", "barrel", "script"] as const);
    const file = this.newPath(k);
    this.specs.set(file, this.makeSpec(k));
    return file;
  }

  /** Re-derives the content of an existing file (keeping its kind), possibly keeping part of it. */
  modify(file: string): void {
    const old = this.specs.get(file);
    if (!old) return;
    const fresh = this.makeSpec(old.kind);
    const mode = this.rng.int(5);
    if (mode === 0) {
      // only change an event literal / marker
      this.specs.set(file, { ...old, calls: old.calls.map((c) => ({ ...c, event: this.rng.chance(0.5) ? this.event() : c.event })), marker: fresh.marker });
    } else if (mode === 1 && old.kind === "lib") {
      // toggle one wrapper between wrapper and non-wrapper form
      const ws = old.wrappers.map((w, i) => (i === 0 ? { ...w, form: w.form === "none" ? ("function" as const) : ("none" as const) } : w));
      this.specs.set(file, { ...old, wrappers: ws, marker: fresh.marker });
    } else if (mode === 2 && old.kind === "lib") {
      // rename a wrapper (importers now dangle until they are edited)
      const ws = old.wrappers.map((w, i) => (i === 0 ? { ...w, name: `w${this.rng.int(40)}` } : w));
      this.specs.set(file, { ...old, wrappers: ws, marker: fresh.marker });
    } else if (mode === 3) {
      this.specs.set(file, { ...fresh, broken: undefined });
    } else {
      // add a call or a wrapper
      this.specs.set(file, { ...old, calls: [...old.calls, this.randomCall()], marker: fresh.marker });
    }
  }

  setBroken(file: string, broken: FileSpec["broken"]): void {
    const spec = this.specs.get(file);
    if (spec) this.specs.set(file, { ...spec, broken });
  }

  delete(file: string): void {
    const spec = this.specs.get(file);
    if (spec) this.graveyard.set(file, spec);
    this.specs.delete(file);
  }

  /** Brings a deleted path back, so importers that still point at it start to resolve again. */
  recreate(): string | undefined {
    const paths = [...this.graveyard.keys()].filter((f) => !this.specs.has(f));
    if (!paths.length) return undefined;
    const file = this.rng.pick(paths);
    const spec = this.graveyard.get(file)!;
    this.graveyard.delete(file);
    this.specs.set(file, { ...spec, broken: undefined, marker: this.marker++ });
    return file;
  }

  rename(file: string): string | undefined {
    const spec = this.specs.get(file);
    if (!spec) return undefined;
    const next = this.newPath(spec.kind);
    this.delete(file);
    this.specs.set(next, spec);
    return next;
  }
}

// ---------- comparison ----------

interface Snapshot {
  readonly events: string[];
  readonly wrappers: string[];
  readonly dynamic: string[];
}

function snapshotOf(engine: EventraEngine, files: readonly string[], root: string): Record<string, Snapshot> {
  const rel = (f: string): string => path.relative(root, f).replace(/\\/g, "/");
  const out: Record<string, Snapshot> = {};
  for (const file of files) {
    const r = engine.getScanResult(getVirtualFile(file));
    out[rel(file)] = {
      events: [...r.events].sort(),
      wrappers: [...r.detectedFunctionWrappers].sort(),
      dynamic: r.dynamicOccurrences
        .map((o) => `${rel(o.fileName)}:${o.line}:${o.character}:${o.calleeText}:${o.callText}:${[...o.resolvedValues].sort().join("|")}:${o.inTemplate ?? ""}:${o.eventExpression ?? ""}`)
        .sort(),
    };
  }
  return out;
}

function globalOf(engine: EventraEngine, root: string): unknown {
  const rel = (f: string): string => path.relative(root, f).replace(/\\/g, "/");
  return {
    events: engine.getAllEvents(),
    wrappers: engine.getAllFunctionWrappers(),
    dynamic: engine.getAllDynamicOccurrences().map((o) => `${rel(o.fileName)}:${o.line}:${o.character}:${o.calleeText}:${o.resolvedValues.join("|")}`),
  };
}

export interface Mismatch {
  readonly seed: number;
  readonly step: number;
  readonly description: string;
  readonly detail: string;
}

export interface RunReport {
  readonly seed: number;
  readonly steps: number;
  readonly files: number;
  readonly mismatches: Mismatch[];
}

export interface RunOptions {
  readonly seed: number;
  readonly steps: number;
  readonly initialFiles: number;
  readonly dirs: readonly string[];
  readonly tsconfig: boolean;
  /** stop at the first mismatch (default) or keep going and collect all */
  readonly keepGoing?: boolean;
}

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: { include: ["**/*.ts"], exclude: ["node_modules"] },
};

function write(root: string, file: string, content: string): void {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Runs one seed inside a fresh temp directory. Changes process.cwd() while running. */
export async function runSeed(options: RunOptions): Promise<RunReport> {
  const rng = new Rng(options.seed);
  const project = new Project(rng, options.dirs);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `eventra-diff-${options.seed}-`)));
  const previousCwd = process.cwd();
  const mismatches: Mismatch[] = [];

  // last content written for each file; a diff against it is what a file
  // watcher would report (a dependent whose render changed is a change too)
  const disk = new Map<string, string>();

  /** Writes the project to disk and returns the files that changed or vanished. */
  const flushToDisk = (): { changed: string[]; removed: string[] } => {
    const changed: string[] = [];
    const removed: string[] = [];
    for (const f of [...disk.keys()]) {
      if (!project.specs.has(f)) {
        fs.rmSync(path.join(root, f), { force: true });
        disk.delete(f);
        removed.push(f);
      }
    }
    for (const [f, spec] of project.specs) {
      const content = render(f, spec, project.specs);
      if (disk.get(f) === content) continue;
      write(root, f, content);
      disk.set(f, content);
      changed.push(f);
    }
    return { changed, removed };
  };

  try {
    process.chdir(root);
    if (options.tsconfig) {
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false, target: "esnext", module: "esnext", moduleResolution: "bundler" }, include: ["**/*.ts"] }));
    }

    // initial project: libs first so callers can reference them
    for (let i = 0; i < Math.max(2, Math.floor(options.initialFiles / 3)); i++) project.create("lib");
    for (let i = 0; i < options.initialFiles; i++) project.create();
    flushToDisk();

    const initial = await scanProject(CONFIG);
    const engine: EventraEngine = initial.engine;
    const plugins: PluginRegistry = initial.plugins;
    const tracked = new Set<string>();
    const sourceFiles = (): string[] => [...project.specs.keys()].map((f) => path.join(root, f).replace(/\\/g, "/"));
    for (const f of sourceFiles()) tracked.add(f);

    const compare = async (step: number, description: string): Promise<boolean> => {
      const fresh = await scanProject(CONFIG);
      const files = [...new Set([...sourceFiles(), ...tracked])];
      const a = snapshotOf(engine, files, root);
      const b = snapshotOf(fresh.engine, files, root);
      const ga = JSON.stringify(globalOf(engine, root));
      const gb = JSON.stringify(globalOf(fresh.engine, root));
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      if (sa === sb && ga === gb) return true;
      const differing = Object.keys(b).filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
      const first = differing[0];
      mismatches.push({
        seed: options.seed,
        step,
        description,
        detail: first
          ? `file ${first}\n  incremental: ${JSON.stringify(a[first])}\n  fresh:       ${JSON.stringify(b[first])}`
          : `aggregate differs\n  incremental: ${ga}\n  fresh:       ${gb}`,
      });
      return false;
    };

    if (!(await compare(0, "initial scan"))) {
      return { seed: options.seed, steps: 0, files: project.specs.size, mismatches };
    }

    let executed = 0;
    for (let step = 1; step <= options.steps; step++) {
      const ops: string[] = [];
      const touched = new Set<string>();
      const removed = new Set<string>();
      const opCount = 1 + (rng.chance(0.35) ? rng.int(3) : 0);

      for (let i = 0; i < opCount; i++) {
        const files = [...project.specs.keys()];
        const op = rng.pick(["modify", "modify", "modify", "create", "create", "delete", "delete", "rename", "break", "fix", "touch", "recreate", "recreate"] as const);
        if (op === "create" || files.length === 0) {
          const f = project.create();
          touched.add(f);
          ops.push(`create ${f}`);
        } else if (op === "recreate") {
          const f = project.recreate();
          if (f) {
            touched.add(f);
            ops.push(`recreate ${f}`);
          }
        } else if (op === "delete" && files.length > 3) {
          const f = rng.pick(files);
          project.delete(f);
          removed.add(f);
          touched.delete(f);
          ops.push(`delete ${f}`);
        } else if (op === "rename") {
          const f = rng.pick(files);
          const next = project.rename(f);
          if (next) {
            removed.add(f);
            touched.delete(f);
            touched.add(next);
            ops.push(`rename ${f} -> ${next}`);
          }
        } else if (op === "break") {
          const f = rng.pick(files);
          project.setBroken(f, rng.pick(["truncate", "garbage", "badImport"] as const));
          touched.add(f);
          ops.push(`break ${f}`);
        } else if (op === "fix") {
          const f = rng.pick(files);
          project.setBroken(f, undefined);
          touched.add(f);
          ops.push(`fix ${f}`);
        } else if (op === "touch") {
          const f = rng.pick(files);
          touched.add(f);
          ops.push(`touch ${f}`);
        } else {
          const f = rng.pick(files);
          project.modify(f);
          touched.add(f);
          ops.push(`modify ${f}`);
        }
      }

      // dangling importers are part of the game: nothing is repaired here
      const { changed, removed: gone } = flushToDisk();
      for (const f of gone) removed.add(f);
      for (const f of changed) touched.add(f);
      for (const f of removed) touched.delete(f);
      // a rename removes the old path and creates the new one in one step
      for (const f of [...removed]) if (project.specs.has(f)) removed.delete(f);

      const concurrent = rng.chance(0.5);
      const toUpdate = [...touched].filter((f) => project.specs.has(f));
      ops.push(`(events: ${toUpdate.length} changed, ${removed.size} removed)`);
      const run = async (): Promise<void> => {
        for (const f of removed) {
          const abs = path.join(root, f).replace(/\\/g, "/");
          for (const virtualPath of plugins.getVirtualPathsForSource(abs).length ? plugins.getVirtualPathsForSource(abs) : [abs]) {
            tracked.delete(virtualPath);
            await engine.removeFile(getVirtualFile(virtualPath), CONFIG);
          }
        }
        const update = async (f: string): Promise<void> => {
          const abs = path.join(root, f).replace(/\\/g, "/");
          const content = fs.readFileSync(abs, "utf8");
          tracked.add(abs);
          await engine.updateFile(getVirtualFile(abs), content, CONFIG);
        };
        if (concurrent) await Promise.all(toUpdate.map(update));
        else for (const f of toUpdate) await update(f);
      };
      await run();
      executed = step;

      const ok = await compare(step, `${concurrent ? "concurrent" : "sequential"}: ${ops.join("; ")}`);
      if (!ok && !options.keepGoing) break;
    }

    return { seed: options.seed, steps: executed, files: project.specs.size, mismatches };
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
