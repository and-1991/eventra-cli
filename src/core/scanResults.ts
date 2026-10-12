import { EventraEngine } from "./EventraEngine";
import { EventraConfig, FunctionWrapperConfig } from "../types";
import { normalizeConfig, saveConfig } from "../config/config";

export interface BuildConfigOptions {
  /**
   * Set when some files could not be analysed. Their events are missing from
   * the scan, and eventra.json does not record which file an event came from,
   * so nothing already known is dropped: the result is the union of the
   * previous and the found events and wrappers.
   */
  readonly preserveKnown?: boolean;
}

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

export function buildConfigFromScan(
  config: EventraConfig,
  engine: EventraEngine,
  options: BuildConfigOptions = {},
): EventraConfig {
  const foundWrappers = engine.getAllFunctionWrappers();
  const foundEvents = engine.getAllEvents();

  if (options.preserveKnown) {
    return {
      ...config,
      events: uniqueSorted([...(config.events ?? []), ...foundEvents]),
      functionWrappers: uniqueSorted([
        ...(config.functionWrappers ?? []).map((w) => w.name),
        ...foundWrappers,
      ]).map((name) => ({ name })),
    };
  }

  const functionWrappers: FunctionWrapperConfig[] = foundWrappers.map((name) => ({ name }));

  return {
    ...config,
    events: foundEvents,
    functionWrappers,
  };
}

export async function persistScanResults(
  config: EventraConfig,
  engine: EventraEngine,
  options: BuildConfigOptions = {},
): Promise<EventraConfig> {
  const next = buildConfigFromScan(config, engine, options);
  await saveConfig(next);
  // what is now in eventra.json: callers report these counts
  return normalizeConfig(next);
}
