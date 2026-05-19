/* eslint-disable */

declare function track(event: string): void;

function trackFeature(event: string) {
  track(event);
}

const analytics = {
  trackFeature(event: string) {
    track(event);
  },
  events: {
    trackFeature(event: string) {
      track(event);
    },
  },
};

const eventName = "variable_event";

// ===== basic =====
trackFeature("wrapper_function");

// ===== multiline =====
trackFeature(
  "multiline_function"
);

// ===== template string =====
trackFeature(`template_function`);

// ===== conditional =====
if (true) {
  trackFeature("conditional_function");
}

// ===== ternary =====
true
  ? trackFeature("ternary_a")
  : trackFeature("ternary_b");

// ===== variable =====
trackFeature(eventName);

// ===== function =====
function run() {
  trackFeature("function_event");
}

// ===== arrow =====
const test = () => {
  trackFeature("arrow_event");
};

// ===== class =====
class Service {
  run() {
    trackFeature("class_event");
  }
}

// ===== nested function =====
function outer() {
  function inner() {
    trackFeature("nested_function");
  }
}

// ===== object wrapper =====
analytics.trackFeature("object_wrapper");

// ===== nested object wrapper =====
analytics.events.trackFeature("nested_object_wrapper");
