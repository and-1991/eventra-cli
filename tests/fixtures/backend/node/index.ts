import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

/* eslint-disable */


const eventName = "variable_event";

// ===== direct =====
tracker.track("node_event");

// ===== multiline =====
tracker.track(
  "multiline_event"
);

// ===== template string =====
tracker.track(`template_event`);

// ===== conditional =====
if (true) {
  tracker.track("conditional_event");
}

// ===== ternary =====
true
  ? tracker.track("ternary_a")
  : tracker.track("ternary_b");

// ===== variable =====
tracker.track(eventName);

// ===== function =====
function run() {
  tracker.track("function_event");
}

// ===== arrow =====
const handler = () => {
  tracker.track("arrow_event");
};

// ===== class =====
class Service {
  run() {
    tracker.track("class_event");
  }
}

// ===== nested =====
function outer() {
  function inner() {
    tracker.track("nested_event");
  }
}

// ===== async =====
async function asyncRun() {
  tracker.track("async_event");
}

// ===== promise =====
Promise.resolve().then(() => {
  tracker.track("promise_event");
});
