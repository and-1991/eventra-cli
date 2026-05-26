/* eslint-disable */
// @ts-ignore
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

export function trackFeature(event: string): void {
  tracker.track(event);
}
