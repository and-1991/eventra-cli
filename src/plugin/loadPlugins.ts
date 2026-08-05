import type { EventraConfig } from "../types";
import { registerExternalCliPlugin, isExternalCliPlugin } from "./adapters/external";
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

async function loadExternalPlugin(registry: PluginRegistry, spec: string): Promise<void> {
  const trimmed = spec.trim();
  // Defensive-only: the sole caller (createPluginRegistry) already does
  // `if (!trimmed) continue;` before ever calling this function, so `spec`
  // here is always non-blank. Kept as a guard in case a future caller is
  // added that doesn't pre-filter.
  /* v8 ignore next */
  if (!trimmed) return;

  let mod: unknown;
  try {
    mod = await import(trimmed);
  } catch (err) {
    // Node's dynamic import() only ever rejects with an Error (module
    // resolution, syntax, or evaluation errors are all Error instances) —
    // the String(err) fallback can't be reached without a plugin module
    // whose top-level code does a bare `throw "non-error value"`, which
    // we won't fabricate as a persistent test fixture. Defensive-only.
    /* v8 ignore next */
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load plugin "${trimmed}": ${message}.${pluginLoadHint(trimmed)}`);
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
  for (const spec of config.plugins ?? []) {
    const trimmed = spec.trim();
    if (!trimmed) continue;

    if (!isTrustedPluginSpecifier(trimmed)) {
      console.warn(
        `Eventra: skipping plugin "${trimmed}" — only official @eventra_dev/cli-plugin-* packages can be loaded.${pluginLoadHint(trimmed)}`,
      );
      continue;
    }

    await loadExternalPlugin(registry, trimmed);
  }
  return registry;
}
