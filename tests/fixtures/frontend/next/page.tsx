import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

/* eslint-disable */

function trackFeature(event: string) {
  tracker.track(event);
}

declare const analytics: any;
declare const Button: any;
declare const TrackedButton: any;
declare const MyButton: any;

const eventName = "variable_event";

export default function Page() {
  // ===== direct =====
  tracker.track("next_event");

  // ===== multiline =====
  tracker.track(
    "multiline_event"
  );

  // ===== template string =====
  tracker.track(`template_event`);

  // ===== wrapper function =====
  trackFeature("wrapper_function");

  // non-SDK analytics calls are ignored by CLI

  // ===== variable =====
  tracker.track(eventName);

  // ===== conditional =====
  if (true) {
    tracker.track("conditional_event");
  }

  // ===== ternary =====
  true
    ? tracker.track("ternary_a")
    : tracker.track("ternary_b");

  // ===== arrow function =====
  const run = () => {
    tracker.track("arrow_event");
  };

  // ===== function =====
  function test() {
    tracker.track("function_event");
  }

  // ===== class =====
  class Service {
    run() {
      tracker.track("class_event");
    }
  }

  return (
    <>
      {/* basic */}
      <Button event="next_button" />

      {/* expression */}
      <Button event={"expression_event"} />

      {/* wrapper component */}
      <TrackedButton event="tracked_button" />

      {/* another wrapper */}
      <MyButton event="my_button" />

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
