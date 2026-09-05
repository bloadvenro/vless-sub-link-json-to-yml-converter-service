import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";

import type { RuntimeConfig } from "../src/config.js";
import { RequestAbortedError, UpstreamError } from "../src/errors.js";
import { createGateway, type Gateway, type GatewayOptions } from "../src/server.js";
import type { UpstreamResult } from "../src/upstream.js";
import { malformedUtf8Subscription, vlessTcpTls } from "./fixtures.js";

const config: RuntimeConfig = {
  subscriptionUrl: new URL("https://provider.example.test/synthetic"),
  userAgent: "Synthetic-UA",
};

const validResult = (): UpstreamResult => ({
  body: Buffer.from(JSON.stringify([vlessTcpTls()])),
  headers: {},
});

const start = async (
  options: GatewayOptions = { fetcher: async () => validResult() },
): Promise<{ gateway: Gateway; origin: string; port: number }> => {
  const gateway = createGateway(config, options);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address() as AddressInfo;
  return {
    gateway,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
  };
};

const eventually = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
};

test("serves health without upstream access and validates routes before acquiring", async () => {
  let fetches = 0;
  const { gateway, origin } = await start({
    fetcher: async () => {
      fetches += 1;
      return validResult();
    },
  });
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(await health.text(), '{"status":"ok"}\n');

    const missing = await fetch(`${origin}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not Found\n");

    const method = await fetch(`${origin}/sub`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");
    assert.equal(await method.text(), "Method Not Allowed\n");
    assert.equal(fetches, 0);
    assert.equal(gateway.activeSubscriptions(), 0);
  } finally {
    await gateway.drain();
  }
});

test("returns complete YAML and forwards approved success headers only on success", async () => {
  const { gateway, origin } = await start({
    fetcher: async () => ({
      ...validResult(),
      headers: {
        "subscription-userinfo": "upload=1; download=2",
        "profile-update-interval": "24",
      },
    }),
  });
  try {
    const response = await fetch(`${origin}/sub`, {
      headers: { "X-Inbound-Secret": "must-not-be-forwarded" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/yaml; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("subscription-userinfo"), "upload=1; download=2");
    assert.match(await response.text(), /^proxies:/u);
  } finally {
    await gateway.drain();
  }
});

test("returns 502 without YAML for a malformed UTF-8 subscription", async () => {
  const { gateway, origin } = await start({
    fetcher: async () => ({ body: malformedUtf8Subscription(), headers: {} }),
  });
  try {
    const response = await fetch(`${origin}/sub`);
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(body, "Bad Gateway\n");
    assert.equal(body.includes("proxies:"), false);
  } finally {
    await gateway.drain();
  }
});

test("maps all failures to static bodies and emits no partial YAML", async () => {
  const cases: Array<{
    expectedBody: string;
    expectedStatus: number;
    fetcher: NonNullable<GatewayOptions["fetcher"]>;
  }> = [
    {
      fetcher: async () => {
        throw new UpstreamError("bad-gateway");
      },
      expectedStatus: 502,
      expectedBody: "Bad Gateway\n",
    },
    {
      fetcher: async () => {
        throw new UpstreamError("timeout");
      },
      expectedStatus: 504,
      expectedBody: "Gateway Timeout\n",
    },
    {
      fetcher: async () => ({ body: Buffer.from("not json"), headers: {} }),
      expectedStatus: 502,
      expectedBody: "Bad Gateway\n",
    },
    {
      fetcher: async () => ({
        body: Buffer.from(
          JSON.stringify([vlessTcpTls(), { remarks: "bad", outbounds: [] }]),
        ),
        headers: {},
      }),
      expectedStatus: 502,
      expectedBody: "Bad Gateway\n",
    },
    {
      fetcher: async () => {
        throw new Error("synthetic-secret-marker");
      },
      expectedStatus: 500,
      expectedBody: "Internal Server Error\n",
    },
  ];

  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    for (const item of cases) {
      const { gateway, origin } = await start({ fetcher: item.fetcher });
      try {
        const response = await fetch(`${origin}/sub`);
        assert.equal(response.status, item.expectedStatus);
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(await response.text(), item.expectedBody);
      } finally {
        await gateway.drain();
      }
    }
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logs, ["Request failed: unexpected"]);
  assert.equal(logs.join("\n").includes("synthetic-secret-marker"), false);
});

test("allows four fresh upstream requests and rejects the fifth until a response finishes", async () => {
  const pending: Array<(result: UpstreamResult) => void> = [];
  let calls = 0;
  const { gateway, origin } = await start({
    fetcher: async () => {
      calls += 1;
      return new Promise<UpstreamResult>((resolve) => pending.push(resolve));
    },
  });
  try {
    const firstFour = Array.from({ length: 4 }, () => fetch(`${origin}/sub`));
    await eventually(() => gateway.activeSubscriptions() === 4);
    assert.equal(calls, 4);

    const fifth = await fetch(`${origin}/sub`);
    assert.equal(fifth.status, 503);
    assert.equal(fifth.headers.get("retry-after"), "5");
    assert.equal(await fifth.text(), "Service Unavailable\n");
    assert.equal(calls, 4);

    for (const resolve of pending) resolve(validResult());
    const completed = await Promise.all(firstFour);
    assert.deepEqual(completed.map((response) => response.status), [200, 200, 200, 200]);
    await Promise.all(completed.map((response) => response.arrayBuffer()));
    await eventually(() => gateway.activeSubscriptions() === 0);
  } finally {
    await gateway.drain();
  }
});

test("response deadline aborts stalled work and releases its subscription slot", async () => {
  let aborted = false;
  const { gateway, origin } = await start({
    responseDeadlineMs: 30,
    fetcher: async (_runtimeConfig, requestSignal) =>
      new Promise<UpstreamResult>((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new RequestAbortedError());
          },
          { once: true },
        );
      }),
  });
  const request = fetch(`${origin}/sub`).catch(() => undefined);
  try {
    await eventually(() => gateway.activeSubscriptions() === 1);
    await eventually(() => aborted && gateway.activeSubscriptions() === 0);
    await request;
    assert.equal(aborted, true);
  } finally {
    await gateway.drain();
  }
});

test("client disconnect aborts upstream and writes no response bytes", async () => {
  let started = false;
  let aborted = false;
  const { gateway, port } = await start({
    fetcher: async (_runtimeConfig, requestSignal) => {
      started = true;
      return new Promise<UpstreamResult>((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new RequestAbortedError());
          },
          { once: true },
        );
      });
    },
  });
  let responseBytes = 0;
  const request = httpRequest({ host: "127.0.0.1", port, path: "/sub" });
  request.on("response", (response) => {
    response.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
    });
  });
  request.on("error", () => undefined);
  request.end();
  try {
    await eventually(() => started);
    request.destroy();
    await eventually(() => aborted && gateway.activeSubscriptions() === 0);
    assert.equal(responseBytes, 0);
  } finally {
    await gateway.drain();
  }
});

test("draining answers a pipelined keep-alive request with 503 then exits normally", async () => {
  let release: ((result: UpstreamResult) => void) | undefined;
  let started = false;
  const { gateway, port } = await start({
    fetcher: async () => {
      started = true;
      return new Promise<UpstreamResult>((resolve) => {
        release = resolve;
      });
    },
  });
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    received += chunk;
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("GET /sub HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
  await eventually(() => started);
  const draining = gateway.drain();
  socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  release?.(validResult());
  await new Promise<void>((resolve) =>
    socket.once("close", () => {
      resolve();
    }),
  );
  assert.equal(await draining, 0);
  assert.match(received, /HTTP\/1\.1 200 OK/u);
  assert.match(received, /HTTP\/1\.1 503 Service Unavailable/u);
  assert.match(received, /Connection: close/iu);
});

test("forced drain aborts active work, closes connections, and returns exit code 1", async () => {
  let aborted = false;
  const { gateway, origin } = await start({
    drainGraceMs: 30,
    fetcher: async (_runtimeConfig, requestSignal) =>
      new Promise<UpstreamResult>((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new RequestAbortedError());
          },
          { once: true },
        );
      }),
  });
  const request = fetch(`${origin}/sub`).catch(() => undefined);
  await eventually(() => gateway.activeSubscriptions() === 1);
  assert.equal(await gateway.drain(), 1);
  await request;
  await eventually(() => gateway.activeSubscriptions() === 0);
  assert.equal(aborted, true);
});
