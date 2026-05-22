import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

/* eslint-disable */


const express = (...args: any[]) => ({
  get: (...args: any[]) => {},
  post: (...args: any[]) => {},
  put: (...args: any[]) => {},
  delete: (...args: any[]) => {},
  use: (...args: any[]) => {},
  listen: (...args: any[]) => {}
});

const app = express();

// =========================
// BASIC
// =========================

tracker.track("express_event");

// =========================
// VARIABLES
// =========================

const eventName = "variable_event";
tracker.track(eventName);

let anotherEvent;
anotherEvent = "assigned_event";
tracker.track(anotherEvent);

// =========================
// TEMPLATE
// =========================

tracker.track(`template_event`);

const id = "123";
tracker.track(`template_${id}`); // dynamic

// =========================
// MIDDLEWARE
// =========================

app.use(() => {
  tracker.track("middleware_event");
});

// =========================
// ROUTES
// =========================

app.get("/", () => {
  tracker.track("get_event");
});

app.post("/users", () => {
  tracker.track("post_event");
});

app.put("/users", () => {
  tracker.track("put_event");
});

app.delete("/users", () => {
  tracker.track("delete_event");
});

// =========================
// NESTED
// =========================

app.get("/nested", () => {
  if (true) {
    tracker.track("nested_event");
  }
});

// =========================
// ASYNC
// =========================

app.get("/async", async () => {
  tracker.track("async_event");
});

// =========================
// ARROW HANDLER
// =========================

const handler = () => {
  tracker.track("arrow_event");
};

app.get("/arrow", handler);

// =========================
// FUNCTION DECLARATION
// =========================

function service() {
  tracker.track("function_event");
}

// =========================
// CLASS
// =========================

class Service {
  run() {
    tracker.track("class_event");
  }
}

// =========================
// LISTEN
// =========================

app.listen(3000, () => {
  tracker.track("listen_event");
});

// =========================
// OBJECT WRAPPER
// =========================

const analyticsWrapper = {
  log(event: string) {
    tracker.track(event);
  },
};

analyticsWrapper.log("object_wrapper_event");

const analyticsDeep = {
  events: {
    log(event: string) {
      tracker.track(event);
    },
  },
};

analyticsDeep.events.log("nested_object_wrapper_event");

// =========================
// CONDITIONALS
// =========================

if (true) {
  tracker.track("if_event");
} else {
  tracker.track("else_event");
}

// ternary
true
  ? tracker.track("ternary_true")
  : tracker.track("ternary_false");

// =========================
// ARRAYS
// =========================

[
  () => tracker.track("array_1"),
  () => tracker.track("array_2")
];

// =========================
// LOOP
// =========================

for (let i = 0; i < 1; i++) {
  tracker.track("loop_event");
}

// =========================
// TRY / CATCH
// =========================

try {
  tracker.track("try_event");
} catch {
  tracker.track("catch_event");
}

// =========================
// RETURN
// =========================

function returnTest() {
  return tracker.track("return_event");
}

// =========================
// PARAM DEFAULT
// =========================

function withDefault(e = "default_event") {
  tracker.track(e);
}

// =========================
// INLINE OBJECT
// =========================

tracker.track("object_payload_event");

// =========================
// OPTIONAL CHAINING
// =========================

tracker?.track("optional_chain_event");

// =========================
// EDGE CASES
// =========================

// not first argument (should be ignored usually)
// @ts-ignore
tracker.track("real_event", "extra");

// no args
// @ts-ignore
tracker.track();

// dynamic identifier (should be dynamic)
const dynamicEvent = Math.random() > 0.5 ? "a" : "b";
tracker.track(dynamicEvent);

// =========================
// END
// =========================
