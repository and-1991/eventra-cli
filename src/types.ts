export interface ScanResult {
  readonly events: Set<string>;
  readonly detectedFunctionWrappers: Set<string>;
}

export interface EventraConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly events: string[];
  readonly sync: {
    readonly include: string[];
    readonly exclude: string[];
  };
}
