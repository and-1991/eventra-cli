<script setup lang="ts">
/* eslint-disable */

declare function track(event: string): void
declare function trackFeature(event: string): void

declare const analytics: any

const eventName = "variable_event"
const dynamicButtonEvent = "computed_button_event"

// ===== direct =====
track("vue_event")

// ===== multiline =====
track(
    "multiline_event"
)

// ===== template string =====
track(`template_event`)

// ===== wrapper function =====
trackFeature("wrapper_function")

// ===== object =====
analytics.track("object_track")

// ===== nested object =====
analytics.events.track("nested_track")

// ===== variable =====
track(eventName)

// ===== conditional =====
if (true) {
  track("conditional_event")
}

// ===== ternary =====
true
    ? track("ternary_a")
    : track("ternary_b")

// ===== function =====
function test() {
  track("function_event")
}

// ===== arrow =====
const run = () => {
  track("arrow_event")
}

// ===== class =====
class Service {
  run() {
    track("class_event")
  }
}
</script>

<template>
  <!-- basic -->
  <Button event="vue_button" />

  <!-- expression -->
  <Button event="expression_event" />

  <!-- nested -->
  <div>
    <Button event="nested_button" />
  </div>

  <!-- conditional -->
  <Button
      v-if="true"
      event="conditional_button"
  />

  <!-- array -->
  <Button event="array_1" />
  <Button event="array_2" />

  <!-- dynamic binding, but resolves to a single literal through the merged script scope -->
  <Button :event="dynamicButtonEvent" />

  <!-- dynamic binding, resolves to both branches (still flagged as a dynamic occurrence) -->
  <Button :event="true ? 'ternary_a_button' : 'ternary_b_button'" />
</template>
