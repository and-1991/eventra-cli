export type ScanMode = "strict" | "hybrid" | "discovery";

export type ParseResult = {
  code: string;
  deps: string[];
};

export type Parser = (content: string, file: string) => ParseResult;


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
  aliases?: Record<string, string>;
  sync: {
    include: string[];
    exclude: string[];
  };
};
