/* eslint-disable */

import { Eventra } from "@eventra_dev/eventra-sdk";

const sdk = new Eventra({ apiKey: "test-fixture-key" });

function trackFeature(event: string) {
  sdk.track(event);
}

const analytics = {
  trackFeature(event: string) {
    sdk.track(event);
  },
  events: {
    trackFeature(event: string) {
      sdk.track(event);
    },
  },
};

const eventName = "variable_event";

trackFeature("wrapper_function");

trackFeature(
  "multiline_function"
);

trackFeature(`template_function`);

if (true) {
  trackFeature("conditional_function");
}

true
  ? trackFeature("ternary_a")
  : trackFeature("ternary_b");

trackFeature(eventName);

function run() {
  trackFeature("function_event");
}

const test = () => {
  trackFeature("arrow_event");
};

class Service {
  run() {
    trackFeature("class_event");
  }
}

function outer() {
  function inner() {
    trackFeature("nested_function");
  }
}

analytics.trackFeature("object_wrapper");

analytics.events.trackFeature("nested_object_wrapper");
