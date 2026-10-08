import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createGateway } from "../src/server.js";
import { fetchSubscription, type UpstreamResult } from "../src/upstream.js";
import { malformedUtf8Subscription, vlessTcpTls, vlessWsTls } from "./fixtures.js";

const secret = "synthetic-credential-marker";
const upstreamUrl = new URL(`https://provider.example.test/private/${secret}?token=${secret}`);
const originalFetch = globalThis.fetch;
const config = { listenPort: 0, subscriptionUrl: upstreamUrl, userAgent: secret };

const request = async (fetcher: () => Promise<UpstreamResult>): Promise<{ status: number; body: string }> => {
  const gateway = createGateway(config, { fetcher });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address() as AddressInfo;
  try {
    const response = await originalFetch(`http://127.0.0.1:${address.port}/sub`, {
      headers: { "X-Inbound-Secret": secret },
    });
    return { status: response.status, body: await response.text() };
  } finally {
    await gateway.drain();
  }
};

const record = (logs: string[]): Record<string, unknown> => {
  assert.equal(logs.length, 1);
  const result = JSON.parse(logs[0] ?? "") as Record<string, unknown>;
  assert.equal(result.event, "subscription_error");
  assert.ok(typeof result.elapsed_ms === "number" && result.elapsed_ms >= 0);
  assert.ok((logs[0] ?? "").length < 600);
  for (const privateValue of [secret, upstreamUrl.href, "Error:", "at ", "/dist/", "tls.example.test", "00000000-0000-4000-8000-000000000001"]) {
    assert.equal(logs.join("\n").includes(privateValue), false);
  }
  return result;
};

test("logs upstream reasons and whitelisted network codes without provider secrets", async (t) => {
  const cases = [
    { reason: "http-status", status: 403, response: () => new Response(secret, { status: 403, headers: { "X-Secret": secret } }) },
    { reason: "redirect-missing", status: 302, response: () => new Response(secret, { status: 302 }) },
    { reason: "redirect-invalid", status: 302, response: () => new Response(secret, { status: 302, headers: { Location: `http://example.test/${secret}` } }) },
    { reason: "redirect-limit", status: 302, redirects: 3, response: () => new Response(secret, { status: 302, headers: { Location: `/${secret}` } }) },
    { reason: "body-too-large", status: 200, response: () => new Response(secret, { headers: { "Content-Length": String(5 * 1_024 * 1_024 + 1) } }) },
    { reason: "body-too-large", status: 200, response: () => new Response(new Uint8Array(5 * 1_024 * 1_024 + 1)) },
    {
      reason: "body-read", status: 200, code: "UND_ERR_SOCKET",
      response: () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error(secret, { cause: { code: "UND_ERR_SOCKET", address: secret, message: secret } }));
        },
      })),
    },
  ];
  for (const item of cases) {
    const logs: string[] = [];
    const capture = t.mock.method(console, "error", (...values: unknown[]) => logs.push(values.join(" ")));
    const upstream = t.mock.method(globalThis, "fetch", async () => item.response());
    try {
      assert.deepEqual(await request(() => fetchSubscription(upstreamUrl, secret, new AbortController().signal)), {
        status: 502, body: "Bad Gateway\n",
      });
      const logged = record(logs);
      assert.equal(logged.stage, "upstream");
      assert.equal(logged.reason, item.reason);
      assert.equal(logged.status, 502);
      assert.equal(logged.upstream_status, item.status);
      assert.equal(logged.redirects, item.redirects ?? 0);
      assert.equal(logged.network_code, item.code);
    } finally {
      upstream.mock.restore();
      capture.mock.restore();
    }
  }
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", secret]) {
    const logs: string[] = [];
    const capture = t.mock.method(console, "error", (...values: unknown[]) => logs.push(values.join(" ")));
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      throw new Error(secret, { cause: { code, address: secret, message: secret, stack: secret } });
    });
    try {
      assert.deepEqual(await request(() => fetchSubscription(upstreamUrl, secret, new AbortController().signal)), {
        status: 502, body: "Bad Gateway\n",
      });
      const logged = record(logs);
      assert.equal(logged.reason, "fetch-network");
      assert.equal(logged.stage, "upstream");
      assert.equal(logged.network_code, code === secret ? undefined : code);
    } finally {
      upstream.mock.restore();
      capture.mock.restore();
    }
  }
});

test("logs upstream timeout while preserving the 504 response", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...values: unknown[]) => logs.push(values.join(" ")));
  t.mock.method(globalThis, "fetch", async (_input: unknown, options?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(new Error(secret));
      }, { once: true });
    }));
  assert.deepEqual(await request(() => fetchSubscription(upstreamUrl, secret, new AbortController().signal, { timeoutMs: 20 })), {
    status: 504, body: "Gateway Timeout\n",
  });
  const logged = record(logs);
  assert.equal(logged.stage, "upstream");
  assert.equal(logged.reason, "timeout");
  assert.equal(logged.status, 504);
});

const settings = (profile: Record<string, unknown>, name: string): Record<string, unknown> => {
  const outbound = (profile.outbounds as Array<Record<string, unknown>>)[0];
  assert.ok(outbound !== undefined);
  return (outbound.streamSettings as Record<string, Record<string, unknown>>)[name] ?? {};
};

test("logs conversion format and TLS/WS validation failures without keys or values", async (t) => {
  const unknownTls = vlessTcpTls(secret);
  settings(unknownTls, "tlsSettings")[secret] = secret;
  const missingTls = vlessTcpTls(secret);
  delete settings(missingTls, "tlsSettings").fingerprint;
  const unknownWs = vlessWsTls(secret);
  settings(unknownWs, "wsSettings")[secret] = secret;
  const cases = [
    { body: Buffer.from(`<html>${secret}</html>`), reason: "invalid-json" },
    { body: malformedUtf8Subscription(), reason: "invalid-utf8" },
    { body: Buffer.from(JSON.stringify([unknownTls])), reason: "schema-validation", issue: "unknown-fields", fn: "parseTlsSettings" },
    { body: Buffer.from(JSON.stringify([missingTls])), reason: "schema-validation", issue: "missing-fields", fn: "parseTlsSettings" },
    { body: Buffer.from(JSON.stringify([unknownWs])), reason: "schema-validation", issue: "unknown-fields", fn: "parseWsSettings" },
  ];
  for (const item of cases) {
    const logs: string[] = [];
    const capture = t.mock.method(console, "error", (...values: unknown[]) => logs.push(values.join(" ")));
    try {
      assert.deepEqual(await request(async () => ({ body: item.body, headers: { "content-disposition": secret } })), {
        status: 502, body: "Bad Gateway\n",
      });
      const logged = record(logs);
      assert.equal(logged.stage, "conversion");
      assert.equal(logged.reason, item.reason);
      assert.equal(logged.validation_issue, item.issue);
      assert.equal(logged.conversion_function, item.fn);
      if (item.fn !== undefined) {
        assert.ok(typeof logged.conversion_line === "number" && logged.conversion_line > 0 && logged.conversion_line < 10_000);
      }
    } finally {
      capture.mock.restore();
    }
  }
});

test("logs success once after completion without subscription data", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => logs.push(values.join(" ")));
  const response = await request(async () => ({
    body: Buffer.from(JSON.stringify([vlessTcpTls(secret)])), headers: { "content-disposition": secret },
  }));
  assert.equal(response.status, 200);
  assert.match(response.body, /^proxies:/u);
  assert.equal(logs.length, 1);
  const logged = JSON.parse(logs[0] ?? "") as Record<string, unknown>;
  assert.equal(logged.event, "subscription_ok");
  assert.equal(logged.status, 200);
  assert.deepEqual(Object.keys(logged).sort(), ["elapsed_ms", "event", "status"]);
  assert.equal(logs.join("\n").includes(secret), false);
});
