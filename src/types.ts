export type ScanMode = "strict" | "hybrid" | "discovery";

export type ScanResult = {
  events: Set<string>;
  detectedFunctionWrappers: Set<string>;
  detectedComponentWrappers: Map<string, string>;
};

export type ParseResult = {
  code: string;
  deps: string[];
};

export type ComponentWrapper = {
  name: string;
  prop: string;
};

export type FunctionWrapper = {
  name: string;
  event?: string;
};

export type EventraConfig = {
  apiKey?: string;
  endpoint?: string;
  events: string[];
  mode?: ScanMode;
  wrappers: ComponentWrapper[];
  functionWrappers: FunctionWrapper[];
  sync: {
    include: string[];
    exclude: string[];
  };
};
