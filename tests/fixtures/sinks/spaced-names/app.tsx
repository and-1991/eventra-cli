// @ts-ignore
import { Eventra } from "@eventra_dev/eventra-sdk";
// @ts-ignore
import posthog from "posthog-js";
// @ts-ignore
import { PostHog } from "posthog-node";
// @ts-ignore
import { Camera } from "camera-lib";

declare const analytics: { track(name: string, props?: object): void };

const sdk = new Eventra({ apiKey: "k" });
const server = new PostHog("key");
const camera = new Camera();

// Eventra SDK: spaces and colons are fine
sdk.track("SDK Direct: Sign Up");

// PostHog preset, client and server shapes
posthog.capture("App: User Sign Up");
posthog.capture("Order Completed", { total: 5 });
posthog.capture("$pageview");
server.capture({ distinctId: "distinct-user-1", event: "Server Side: Direct" });

// custom callee rule
analytics.track("Segment Style: Checkout Started");

// wrapper forwarding a spaced name
export function trackSignup(name: string) {
  posthog.capture(name);
}
trackSignup("Wrapped: Via Helper");

// shorthand forwarding of the server `event` (distinctId must NOT become an event)
export function captureServerEvent({ event, userId }: { event: string; userId: string }) {
  server.capture({ distinctId: userId, event });
}
captureServerEvent({ event: "Server Side: Envelope Sent", userId: "distinct-user-1" });

// not a PostHog receiver: must be ignored
camera.capture("Camera: Photo Taken");

// declarative JSX binding
export const Button = () => <button event="JSX Event: Click Me">go</button>;
