import { createRequire } from "module";
import fs from "fs";
import path from "path";

import type { EventraConfig } from "../types";
import { registerExternalCliPlugin, isExternalCliPlugin } from "./adapters/external";
import { registerConfiguredSinks } from "./builtins/configuredSinks";
import { registerEventraSdkPlugin } from "./builtins/eventra-sdk";
import { registerConsoleDynamicEventReporterPlugin } from "./builtins/consoleDynamicEventReporter";
import { PluginRegistry } from "./registry";

/**
 * Only packages published under the `@eventra_dev` npm scope can ever be
 * `import()`-ed as a plugin. `eventra.json` (and its `plugins` array) is meant
 * to be committed to git, so anything else listed there is attacker-editable
 * via a plain PR — restricting to a scope only the maintainers can publish to
 * turns "arbitrary code execution via a one-line JSON edit" into "not possible
 * without also compromising the @eventra_dev npm account."
 */
const TRUSTED_PLUGIN_RE = /^@eventra_dev\/cli-plugin-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isTrustedPluginSpecifier(spec: string): boolean {
  return TRUSTED_PLUGIN_RE.test(spec);
}

async function resolvePluginExport(mod: unknown): Promise<unknown> {
  let candidate = (mod as { default?: unknown }).default ?? mod;
  if (typeof candidate === "function") {
    candidate = candidate();
  }
  if (candidate && typeof (candidate as Promise<unknown>).then === "function") {
    candidate = await candidate;
  }
  return candidate;
}

function pluginLoadHint(spec: string): string {
  if (spec.includes("plugin-vue") && !spec.includes("cli-plugin-vue")) {
    return " Did you mean @eventra_dev/cli-plugin-vue?";
  }
  return "";
}

/**
 * Plugins are installed in the user's project, not next to the CLI (a global
 * install, npx or a pnpm layout would not find them from here), so resolve from
 * the project first and fall back to normal resolution relative to the CLI.
 */
function resolveFromProject(spec: string): string {
  try {
    return createRequire(path.join(process.cwd(), "package.json")).resolve(spec);
  } catch {
    return spec;
  }
}

/** The `name` of the nearest package.json above a resolved file, or undefined when there is none. */
export function installedPackageName(resolved: string): string | undefined {
  let dir = path.dirname(resolved);
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      let name: unknown;
      try {
        name = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown } | null)?.name;
      } catch {
        name = undefined;
      }
      // a package.json without a name (a nested build folder) or one that cannot be read is not the
      // package's own: keep looking upwards
      if (typeof name === "string") return name;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The name in `plugins` only says what to import. An npm alias
 * (`"@eventra_dev/cli-plugin-vue": "npm:other-package"`) or a git dependency
 * installs another package under that name, and its own package.json says so:
 * such a package is refused instead of being run.
 */
function assertInstalledUnderItsOwnName(spec: string, resolved: string): void {
  if (resolved === spec) return; // not found in the project: import() reports the missing package
  const name = installedPackageName(resolved);
  if (name !== undefined && name !== spec) {
    throw new Error(
      `Refusing to load plugin "${spec}": the package installed under that name is "${name}" (an npm alias or a renamed package). Install the official package with: npm install -D ${spec}`,
    );
  }
}

async function loadExternalPlugin(registry: PluginRegistry, spec: string): Promise<void> {
  const trimmed = spec.trim();
  // Defensive-only: the sole caller (createPluginRegistry) already does
  // `if (!trimmed) continue;` before ever calling this function, so `spec`
  // here is always non-blank. Kept as a guard in case a future caller is
  // added that doesn't pre-filter.
  /* v8 ignore next */
  if (!trimmed) return;

  const resolved = resolveFromProject(trimmed);
  assertInstalledUnderItsOwnName(trimmed, resolved);

  let mod: unknown;
  try {
    mod = await import(resolved);
  } catch (err) {
    // Node's dynamic import() only ever rejects with an Error (module
    // resolution, syntax, or evaluation errors are all Error instances) —
    // the String(err) fallback can't be reached without a plugin module
    // whose top-level code does a bare `throw "non-error value"`, which
    // we won't fabricate as a persistent test fixture. Defensive-only.
    // Node appends a "Require stack" of its own paths to a missing module: the first line says it all
    /* v8 ignore next */
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/\.$/, "");
    // the plugin itself is missing (not one of its own dependencies): say what to install
    const code = (err as { code?: unknown } | null)?.code;
    const notInstalled = (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes(`'${trimmed}'`);
    const install = notInstalled ? ` Install it in your project with: npm install -D ${trimmed}` : "";
    throw new Error(`Failed to load plugin "${trimmed}": ${message}.${pluginLoadHint(trimmed)}${install}`);
  }

  const candidate = await resolvePluginExport(mod);
  if (!isExternalCliPlugin(candidate)) {
    throw new Error(
      `Plugin "${trimmed}" must export a CLI plugin ({ id, includeGlobs, match, transform }).${pluginLoadHint(trimmed)}`,
    );
  }
  registerExternalCliPlugin(candidate, registry);
}

/** Built-in plugins only (sync). Used in tests and as engine default. */
export function createBuiltinPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registerEventraSdkPlugin(registry);
  registerConsoleDynamicEventReporterPlugin(registry);
  return registry;
}

/** Built-ins + plugins listed in eventra.json `plugins` array. */
export async function createPluginRegistry(config: EventraConfig): Promise<PluginRegistry> {
  const registry = createBuiltinPluginRegistry();
  registerConfiguredSinks(registry, config.sinks);
  const raw: unknown = config.plugins;
  const entries: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  if (raw !== undefined && raw !== null && !Array.isArray(raw) && typeof raw !== "string") {
    console.warn(`Eventra: ignoring "plugins": it must be a list of package names, for example ["@eventra_dev/cli-plugin-vue"].`);
  }
  const listed = new Set<string>();
  for (const spec of entries) {
    if (typeof spec !== "string") {
      console.warn(`Eventra: skipping plugin entry ${JSON.stringify(spec)}: a plugin is a package name (a string).`);
      continue;
    }
    const trimmed = spec.trim();
    if (!trimmed) continue;
    // the same plugin listed twice is loaded once
    if (listed.has(trimmed)) continue;
    listed.add(trimmed);

    if (!isTrustedPluginSpecifier(trimmed)) {
      console.warn(
        `Eventra: skipping plugin "${trimmed}" - only official @eventra_dev/cli-plugin-* packages can be loaded.${pluginLoadHint(trimmed)}`,
      );
      continue;
    }

    await loadExternalPlugin(registry, trimmed);
  }
  return registry;
}
