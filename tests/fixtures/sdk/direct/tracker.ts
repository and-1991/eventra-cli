// @ts-ignore
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

tracker.track("sdk.direct");
tracker.track("checkout.completed", { userId: "u1" });

const name = "sdk.variable";
tracker.track(name);

tracker?.track("sdk.optional");

export function run(trackerArg: Eventra) {
  trackerArg.track("sdk.param");
}
