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
  events: string[];
  wrappers: ComponentWrapper[];
  functionWrappers: FunctionWrapper[];
  aliases?: Record<string, string>;
  sync: {
    include: string[];
    exclude: string[];
  };
};

export type ExtractedEvent = {
  value: string;
  dynamic: boolean;
};
