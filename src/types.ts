export interface ScanResult {
  readonly events: Set<string>;
  readonly detectedFunctionWrappers: Set<string>;
}

export interface FunctionWrapperConfig {
  name: string;
}

export interface EventraConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly events: string[];
  functionWrappers?: FunctionWrapperConfig[];
  /** Module specifiers for CLI plugins (e.g. "@eventra_dev/cli-plugin-vue"). */
  readonly plugins?: readonly string[];
  readonly sync: {
    readonly include: string[];
    readonly exclude: string[];
  };
}
