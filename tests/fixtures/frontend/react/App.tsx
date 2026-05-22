import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

/* eslint-disable */

declare function trackFeature(event: string): void;

declare const analytics: any;
declare const Button: any;
declare const TrackedButton: any;
declare const MyButton: any;

const eventName = "variable_event";

// ===== direct =====
tracker.track("direct_event");

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

// ===== wrapper function =====
trackFeature("wrapper_function");

// ===== object function =====
// analytics.track — not @eventra_dev/eventra-sdk (ignored by CLI)

// ===== nested object =====
// analytics.events.track — ignored

// ===== variable (optional support) =====
tracker.track(eventName);

// ===== function =====
function test() {
  tracker.track("function_event");
}

// ===== arrow function =====
const run = () => {
  tracker.track("arrow_event");
};

// ===== class =====
class TestService {
  run() {
    tracker.track("class_event");
  }
}

// ===== component return =====
export default function Page() {
  tracker.track("page_event");

  return (
    <>
      {/* basic */}
      <Button event="button_event" />

      {/* wrapper component */}
      <TrackedButton event="tracked_button" />

      {/* another wrapper */}
      <MyButton event="my_button" />

      {/* expression */}
      <Button event={"expression_event"} />

      {/* nested */}
      <div>
        <Button event="nested_button" />
      </div>

      {/* conditional */}
      {true && (
        <Button event="conditional_button" />
      )}

      {/* ternary */}
      {true
        ? <Button event="ternary_a_button" />
        : <Button event="ternary_b_button" />
      }

      {/* array */}
      {[
        <Button key="1" event="array_1" />,
        <Button key="2" event="array_2" />
      ]}
    </>
  );
}
