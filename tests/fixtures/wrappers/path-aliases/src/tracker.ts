/* eslint-disable */
import { Eventra } from "@eventra_dev/eventra-sdk";

const sdk = new Eventra({ apiKey: "test-fixture-key" });

export function trackFeature(event: string): void {
  sdk.track(event);
}
