import { EventraEngine } from "./EventraEngine";
import { EventraConfig, FunctionWrapperConfig } from "../types";
import { saveConfig } from "../config/config";

export function buildConfigFromScan(
  config: EventraConfig,
  engine: EventraEngine,
): EventraConfig {
  const functionWrappers: FunctionWrapperConfig[] = engine
    .getAllFunctionWrappers()
    .map((name) => ({ name }));

  return {
    ...config,
    events: engine.getAllEvents(),
    functionWrappers,
  };
}

export async function persistScanResults(
  config: EventraConfig,
  engine: EventraEngine,
): Promise<void> {
  await saveConfig(buildConfigFromScan(config, engine));
}
