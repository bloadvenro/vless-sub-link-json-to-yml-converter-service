import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, DEFAULT_USER_AGENT, readConfig } from "../src/config.js";

test("configuration trims outer ASCII whitespace and supplies the default UA", () => {
  const config = readConfig({
    SUBSCRIPTION_URL: " \thttps://example.test/sub?q=token\r\n",
  });
  assert.equal(config.subscriptionUrl.href, "https://example.test/sub?q=token");
  assert.equal(config.userAgent, DEFAULT_USER_AGENT);
  assert.equal(config.listenPort, 17_890);
});

test("configuration accepts exact decimal ports including ephemeral zero", () => {
  for (const [raw, expected] of [
    ["0", 0],
    ["00080", 80],
    ["17890", 17_890],
    ["65535", 65_535],
  ] as const) {
    assert.equal(
      readConfig({
        SUBSCRIPTION_URL: "https://example.test/sub",
        PORT: raw,
      }).listenPort,
      expected,
    );
  }
});

test("configuration rejects non-exact or out-of-range ports with a key-only error", () => {
  for (const value of [
    "",
    " ",
    " 80",
    "80 ",
    "+80",
    "-1",
    "1.5",
    "80tcp",
    "65536",
    "999999999999999999999",
  ]) {
    assert.throws(
      () =>
        readConfig({
          SUBSCRIPTION_URL: "https://example.test/sub",
          PORT: value,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.key, "PORT");
        assert.equal(error.message, "Invalid configuration: PORT");
        return true;
      },
    );
  }
});

test("configuration trims a custom UA without changing internal spaces", () => {
  const config = readConfig({
    SUBSCRIPTION_URL: "https://example.test/sub",
    HAPP_USER_AGENT: "\t Custom  Agent \r",
  });
  assert.equal(config.userAgent, "Custom  Agent");
});

test("configuration rejects invalid URLs without including their value", () => {
  const secret = "synthetic-secret-marker";
  for (const value of [
    undefined,
    "",
    "http://example.test/sub",
    "https://user@example.test/sub",
    "https://example.test/sub#fragment",
    "not a url",
    `https://user:${secret}@example.test/sub`,
  ]) {
    assert.throws(
      () => readConfig({ SUBSCRIPTION_URL: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.key, "SUBSCRIPTION_URL");
        assert.equal(error.message, "Invalid configuration: SUBSCRIPTION_URL");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
});

test("configuration measures the UA as UTF-8 and rejects unusable values", () => {
  for (const value of ["  ", "a".repeat(257), "é".repeat(129), "valid\ninvalid"]) {
    assert.throws(
      () =>
        readConfig({
          SUBSCRIPTION_URL: "https://example.test/sub",
          HAPP_USER_AGENT: value,
        }),
      ConfigError,
    );
  }
});
