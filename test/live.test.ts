import { test } from "node:test";

import { DEFAULT_USER_AGENT, readConfig } from "../src/config.js";
import { convertHappText } from "../src/converter.js";
import { fetchSubscription } from "../src/upstream.js";

const subscriptionUrl =
  process.env.TEST_SUBSCRIPTION_URL ?? process.env.SUBSCRIPTION_URL;

test(
  "opt-in live subscription converts without retaining or reporting provider data",
  { skip: subscriptionUrl === undefined },
  async () => {
    try {
      const config = readConfig({
        SUBSCRIPTION_URL: subscriptionUrl,
        HAPP_USER_AGENT: process.env.HAPP_USER_AGENT ?? DEFAULT_USER_AGENT,
      });
      const result = await fetchSubscription(
        config.subscriptionUrl,
        config.userAgent,
        new AbortController().signal,
      );
      convertHappText(result.body);
    } catch {
      throw new Error("Live subscription validation failed");
    }
  },
);
