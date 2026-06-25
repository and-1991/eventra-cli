import type { EventraConfig } from "../types";
import { registerExternalCliPlugin, isExternalCliPlugin } from "./adapters/external";
import { registerEventraSdkPlugin } from "./builtins/eventra-sdk";
import { PluginRegistry } from "./registry";

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
  if (!trimmed) return;

  let mod: unknown;
  try {
    mod = await import(trimmed);
  } catch (err) {
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
  return registry;
}

/** Built-ins + plugins listed in eventra.json `plugins` array. */
export async function createPluginRegistry(config: EventraConfig): Promise<PluginRegistry> {
  const registry = createBuiltinPluginRegistry();
  for (const spec of config.plugins ?? []) {
    await loadExternalPlugin(registry, spec);
  }
  return registry;
}
