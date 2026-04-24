/* eslint-disable */

declare function track(event: string): void;

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

track("express_event");

// =========================
// VARIABLES
// =========================

const eventName = "variable_event";
track(eventName);

let anotherEvent;
anotherEvent = "assigned_event";
track(anotherEvent);

// =========================
// TEMPLATE
// =========================

track(`template_event`);

const id = "123";
track(`template_${id}`); // dynamic

// =========================
// MIDDLEWARE
// =========================

app.use(() => {
  track("middleware_event");
});

// =========================
// ROUTES
// =========================

app.get("/", () => {
  track("get_event");
});

app.post("/users", () => {
  track("post_event");
});

app.put("/users", () => {
  track("put_event");
});

app.delete("/users", () => {
  track("delete_event");
});

// =========================
// NESTED
// =========================

app.get("/nested", () => {
  if (true) {
    track("nested_event");
  }
});

// =========================
// ASYNC
// =========================

app.get("/async", async () => {
  track("async_event");
});

// =========================
// ARROW HANDLER
// =========================

const handler = () => {
  track("arrow_event");
};

app.get("/arrow", handler);

// =========================
// FUNCTION DECLARATION
// =========================

function service() {
  track("function_event");
}

// =========================
// CLASS
// =========================

class Service {
  run() {
    track("class_event");
  }
}

// =========================
// LISTEN
// =========================

app.listen(3000, () => {
  track("listen_event");
});

// =========================
// OBJECT WRAPPER
// =========================

const analytics = {
  track
};

analytics.track("object_event");

// nested object
const analyticsDeep = {
  events: {
    track
  }
};

analyticsDeep.events.track("nested_object_event");

// =========================
// CONDITIONALS
// =========================

if (true) {
  track("if_event");
} else {
  track("else_event");
}

// ternary
true
  ? track("ternary_true")
  : track("ternary_false");

// =========================
// ARRAYS
// =========================

[
  () => track("array_1"),
  () => track("array_2")
];

// =========================
// LOOP
// =========================

for (let i = 0; i < 1; i++) {
  track("loop_event");
}

// =========================
// TRY / CATCH
// =========================

try {
  track("try_event");
} catch {
  track("catch_event");
}

// =========================
// RETURN
// =========================

function returnTest() {
  return track("return_event");
}

// =========================
// PARAM DEFAULT
// =========================

function withDefault(e = "default_event") {
  track(e);
}

// =========================
// INLINE OBJECT
// =========================

track({
  name: "object_payload_event"
} as any);

// =========================
// OPTIONAL CHAINING
// =========================

analytics?.track?.("optional_chain_event");

// =========================
// EDGE CASES
// =========================

// not first argument (should be ignored usually)
// @ts-ignore
track("real_event", "extra");

// no args
// @ts-ignore
track();

// dynamic identifier (should be dynamic)
const dynamicEvent = Math.random() > 0.5 ? "a" : "b";
track(dynamicEvent);

// =========================
// END
// =========================
