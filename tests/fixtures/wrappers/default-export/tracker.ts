/* eslint-disable */
import { Eventra } from "@eventra_dev/eventra-sdk";

const sdk = new Eventra({ apiKey: "test-fixture-key" });

function trackFeature(event: string): void {
  sdk.track(event);
}

export default trackFeature;
