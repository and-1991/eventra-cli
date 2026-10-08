import { AnalyticsBrowser } from "@segment/analytics-next";
import * as amplitude from "@amplitude/analytics-browser";
import posthog from "posthog-js";
import ReactGA from "react-ga4";

declare function gtag(...args: unknown[]): void;
declare const analytics: { track(name: string, props?: object): void };

// Segment
analytics.track("Segment Style: Checkout Started");
export async function load() {
  const [seg] = await AnalyticsBrowser.load({ writeKey: "key" });
  seg.track("Segment Loaded Client: Click");
}

// Amplitude
amplitude.track("Amplitude: Button Clicked");
amplitude.track({ event_type: "Amplitude Object Form" });
amplitude.logEvent("Amplitude Legacy Log");

// GA4: only the "event" command is an event
gtag("event", "GA4 Purchase Completed", { value: 5 });
gtag("config", "G-XXXXXXX");
gtag("set", "user_properties", {});
ReactGA.event("GA4 React: Signup");
ReactGA.event({ category: "nav", action: "GA4 React Action" });

// PostHog
posthog.capture("PostHog: Order Completed");

// a forwarding helper keeps the vendor name out of the call sites
export const trackEverywhere = (name: string) => analytics.track(name);
trackEverywhere("Helper Forwarded: Event");
