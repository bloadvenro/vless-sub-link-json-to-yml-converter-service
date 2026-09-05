import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { RequestAbortedError, UpstreamError } from "../src/errors.js";
import { fetchSubscription } from "../src/upstream.js";
import { vlessTcpTls } from "./fixtures.js";

const MAX_BODY_BYTES = 5 * 1_024 * 1_024;
const certificate = readFileSync("test/fixtures/upstream-cert.pem");
const key = readFileSync("test/fixtures/upstream-key.pem");

const listen = async (
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: HttpsServer; url: URL }> => {
  const server = createServer({ cert: certificate, key }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: new URL(`https://127.0.0.1:${address.port}`) };
};

const close = async (server: HttpsServer): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
};

const signal = (): AbortSignal => new AbortController().signal;

const eventually = async (condition: () => boolean, failureMessage: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail(failureMessage);
};

const isUpstream = (kind: "bad-gateway" | "timeout") => (error: unknown): boolean =>
  error instanceof UpstreamError && error.kind === kind;

test("sends only the application headers and follows every allowed redirect as GET", async () => {
  const seen: Array<{ method: string | undefined; headers: Record<string, string | string[] | undefined> }> = [];
  const statuses = [301, 302, 303, 307, 308];
  const { server, url } = await listen((request, response) => {
    seen.push({ method: request.method, headers: request.headers });
    const match = /^\/redirect\/(\d+)$/u.exec(request.url ?? "");
    if (match !== null) {
      response.writeHead(Number(match[1]), { Location: "/final" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([vlessTcpTls()]));
  });
  try {
    for (const status of statuses) {
      const result = await fetchSubscription(
        new URL(`/redirect/${status}`, url),
        "Synthetic-UA",
        signal(),
      );
      assert.match(Buffer.from(result.body).toString("utf8"), /TLS node/u);
    }
  } finally {
    await close(server);
  }

  assert.equal(seen.length, statuses.length * 2);
  for (const request of seen) {
    assert.equal(request.method, "GET");
    assert.equal(request.headers["user-agent"], "Synthetic-UA");
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["accept-encoding"], "identity");
    assert.equal(request.headers["x-inbound-secret"], undefined);
  }
});

test("rejects missing, malformed, unsafe, excessive, and unsupported redirects", async () => {
  const { server, url } = await listen((request, response) => {
    const path = request.url ?? "";
    if (path === "/missing") response.writeHead(302).end();
    else if (path === "/malformed") {
      response.writeHead(302, { Location: "https://[invalid" }).end();
    } else if (path === "/insecure") {
      response.writeHead(302, { Location: "http://example.test/" }).end();
    } else if (path === "/credentials") {
      response.writeHead(302, { Location: "https://user@example.test/" }).end();
    } else if (path === "/fragment") {
      response.writeHead(302, { Location: "https://example.test/#fragment" }).end();
    } else if (path.startsWith("/chain/")) {
      const count = Number(path.slice("/chain/".length));
      response.writeHead(301, { Location: `/chain/${count + 1}` }).end();
    } else {
      response.writeHead(300).end();
    }
  });
  try {
    for (const path of [
      "/missing",
      "/malformed",
      "/insecure",
      "/credentials",
      "/fragment",
      "/chain/0",
      "/unsupported",
    ]) {
      await assert.rejects(
        fetchSubscription(new URL(path, url), "UA", signal()),
        isUpstream("bad-gateway"),
      );
    }
  } finally {
    await close(server);
  }
});

test("maps network failures and final non-success statuses to bad gateway", async () => {
  const { server, url } = await listen((_request, response) => {
    response.writeHead(503).end("upstream details must not escape");
  });
  try {
    await assert.rejects(
      fetchSubscription(url, "UA", signal()),
      isUpstream("bad-gateway"),
    );
  } finally {
    await close(server);
  }
  await assert.rejects(
    fetchSubscription(new URL("https://127.0.0.1:1/"), "UA", signal(), {
      timeoutMs: 500,
    }),
    isUpstream("bad-gateway"),
  );
});

test("rejects partial content even when its JSON body is valid", async () => {
  const { server, url } = await listen((_request, response) => {
    response.writeHead(206, { "Content-Type": "application/json" });
    response.end(JSON.stringify([vlessTcpTls()]));
  });
  try {
    await assert.rejects(
      fetchSubscription(url, "UA", signal()),
      isUpstream("bad-gateway"),
    );
  } finally {
    await close(server);
  }
});

test("rejects an oversized Content-Length before reading the body", async () => {
  let requestClosed = false;
  const { server, url } = await listen((request, response) => {
    request.once("close", () => {
      requestClosed = true;
    });
    response.writeHead(200, { "Content-Length": String(MAX_BODY_BYTES + 1) });
    response.end("x");
  });
  try {
    await assert.rejects(
      fetchSubscription(url, "UA", signal()),
      isUpstream("bad-gateway"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requestClosed, true);
  } finally {
    await close(server);
  }
});

test("enforces the decoded streaming limit when Content-Length is absent or misleading", async () => {
  const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
  const compressed = gzipSync(oversized);
  const { server, url } = await listen((request, response) => {
    if (request.url === "/chunked") {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let offset = 0; offset < oversized.length; offset += 256 * 1_024) {
        response.write(oversized.subarray(offset, offset + 256 * 1_024));
      }
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Encoding": "gzip",
      "Content-Length": String(compressed.length),
    });
    response.end(compressed);
  });
  try {
    for (const path of ["/chunked", "/compressed"]) {
      await assert.rejects(
        fetchSubscription(new URL(path, url), "UA", signal()),
        isUpstream("bad-gateway"),
      );
    }
  } finally {
    await close(server);
  }
});

test("accepts a compressed JSON response even after requesting identity encoding", async () => {
  let acceptedEncoding: string | undefined;
  const compressed = gzipSync(Buffer.from(JSON.stringify([vlessTcpTls()])));
  const { server, url } = await listen((request, response) => {
    acceptedEncoding = request.headers["accept-encoding"];
    response.writeHead(200, {
      "Content-Encoding": "gzip",
      "Content-Length": String(compressed.length),
    });
    response.end(compressed);
  });
  try {
    const result = await fetchSubscription(url, "UA", signal());
    assert.equal(acceptedEncoding, "identity");
    assert.match(Buffer.from(result.body).toString("utf8"), /TLS node/u);
  } finally {
    await close(server);
  }
});

test("one deadline covers a response that never produces headers", async () => {
  const { server, url } = await listen(() => undefined);
  try {
    await assert.rejects(
      fetchSubscription(url, "UA", signal(), { timeoutMs: 30 }),
      isUpstream("timeout"),
    );
  } finally {
    await close(server);
  }
});

test("an external abort cancels the upstream request", async () => {
  let started = false;
  let closed = false;
  const { server, url } = await listen((request) => {
    started = true;
    request.once("close", () => {
      closed = true;
    });
  });
  const controller = new AbortController();
  const pending = fetchSubscription(url, "UA", controller.signal);
  try {
    await eventually(
      () => started,
      "server did not receive the request before the abort",
    );
    controller.abort();
    await assert.rejects(pending, RequestAbortedError);
    await eventually(
      () => closed,
      "server did not observe the aborted request closing",
    );
  } finally {
    await close(server);
  }
});

test("forwards only safe success metadata within individual and combined limits", async () => {
  const { server, url } = await listen((request, response) => {
    if (request.url === "/normal") {
      response.writeHead(200, {
        "Subscription-Userinfo": "upload=1; download=2",
        "Profile-Update-Interval": "24",
        "Profile-Web-Page-Url": "https://portal.example.test/",
        "Content-Disposition": "attachment; filename=subscription.yaml",
        "X-Not-Allowed": "secret-metadata",
      });
    } else if (request.url === "/individual") {
      response.writeHead(200, { "Subscription-Userinfo": "x".repeat(4_097) });
    } else {
      response.writeHead(200, {
        "Subscription-Userinfo": "a".repeat(3_000),
        "Profile-Update-Interval": "b".repeat(3_000),
        "Profile-Web-Page-Url": "c".repeat(3_000),
      });
    }
    response.end("[]");
  });
  try {
    const normal = await fetchSubscription(new URL("/normal", url), "UA", signal());
    assert.deepEqual(normal.headers, {
      "subscription-userinfo": "upload=1; download=2",
      "profile-update-interval": "24",
      "profile-web-page-url": "https://portal.example.test/",
      "content-disposition": "attachment; filename=subscription.yaml",
    });
    const individual = await fetchSubscription(
      new URL("/individual", url),
      "UA",
      signal(),
    );
    assert.deepEqual(individual.headers, {});
    const combined = await fetchSubscription(new URL("/combined", url), "UA", signal());
    assert.deepEqual(Object.keys(combined.headers), [
      "subscription-userinfo",
      "profile-update-interval",
    ]);
  } finally {
    await close(server);
  }
});
