import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";

import type { RuntimeConfig } from "./config.js";
import { convertHappText } from "./converter.js";
import { ConversionError, RequestAbortedError, UpstreamError } from "./errors.js";
import { fetchSubscription, type UpstreamResult } from "./upstream.js";

const MAX_ACTIVE_SUBSCRIPTIONS = 4;
const DRAIN_GRACE_MS = 5_000;
const RESPONSE_DEADLINE_MS = 30_000;

type SubscriptionFetcher = (
  config: RuntimeConfig,
  signal: AbortSignal,
) => Promise<UpstreamResult>;

export interface GatewayOptions {
  readonly drainGraceMs?: number;
  readonly fetcher?: SubscriptionFetcher;
  readonly responseDeadlineMs?: number;
}

export interface Gateway {
  readonly server: Server;
  readonly activeSubscriptions: () => number;
  readonly drain: () => Promise<0 | 1>;
}

const responseCanBeWritten = (response: ServerResponse): boolean =>
  !response.destroyed && !response.writableEnded;

const writeBody = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: Readonly<Record<string, string>> = {},
): void => {
  if (!responseCanBeWritten(response)) return;
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
};

const writeError = (
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void => {
  writeBody(response, status, "text/plain; charset=utf-8", `${body}\n`, headers);
};

const responseCompletion = (response: ServerResponse): Promise<void> => {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return Promise.race([once(response, "finish"), once(response, "close")]).then(
    () => {
      return undefined;
    },
  );
};

export const createGateway = (
  config: RuntimeConfig,
  options: GatewayOptions = {},
): Gateway => {
  let activeSubscriptions = 0;
  let draining = false;
  let drainPromise: Promise<0 | 1> | undefined;
  const activeControllers = new Set<AbortController>();
  const connections = new Set<Socket>();
  const fetcher: SubscriptionFetcher =
    options.fetcher ??
    ((runtimeConfig, signal) =>
      fetchSubscription(runtimeConfig.subscriptionUrl, runtimeConfig.userAgent, signal));

  const handleSubscription = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (activeSubscriptions >= MAX_ACTIVE_SUBSCRIPTIONS) {
      writeError(response, 503, "Service Unavailable", { "Retry-After": "5" });
      return;
    }

    activeSubscriptions += 1;
    const controller = new AbortController();
    activeControllers.add(controller);
    const completion = responseCompletion(response);
    const responseDeadline = setTimeout(() => {
      if (response.writableFinished || response.destroyed) return;
      controller.abort();
      response.destroy();
    }, options.responseDeadlineMs ?? RESPONSE_DEADLINE_MS);
    responseDeadline.unref();
    const abortForDisconnect = (): void => {
      if (!response.writableFinished) controller.abort();
    };
    request.once("aborted", abortForDisconnect);
    response.once("close", abortForDisconnect);

    try {
      const upstream = await fetcher(config, controller.signal);
      if (controller.signal.aborted || !responseCanBeWritten(response)) return;
      const yaml = convertHappText(upstream.body);
      if (!responseCanBeWritten(response)) return;
      writeBody(
        response,
        200,
        "text/yaml; charset=utf-8",
        yaml,
        upstream.headers,
      );
    } catch (error) {
      if (
        error instanceof RequestAbortedError ||
        controller.signal.aborted ||
        !responseCanBeWritten(response)
      ) {
        return;
      }
      if (error instanceof UpstreamError) {
        writeError(
          response,
          error.kind === "timeout" ? 504 : 502,
          error.kind === "timeout" ? "Gateway Timeout" : "Bad Gateway",
        );
      } else if (error instanceof ConversionError) {
        writeError(response, 502, "Bad Gateway");
      } else {
        console.error("Request failed: unexpected");
        writeError(response, 500, "Internal Server Error");
      }
    } finally {
      try {
        await completion;
      } finally {
        clearTimeout(responseDeadline);
        request.off("aborted", abortForDisconnect);
        response.off("close", abortForDisconnect);
        activeControllers.delete(controller);
        activeSubscriptions -= 1;
      }
    }
  };

  const server = createServer((request, response) => {
    if (draining) {
      writeError(response, 503, "Service Unavailable", { Connection: "close" });
      return;
    }

    const path = request.url;
    if (path !== "/healthz" && path !== "/sub") {
      writeError(response, 404, "Not Found");
      return;
    }
    if (request.method !== "GET") {
      writeError(response, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }
    if (path === "/healthz") {
      writeBody(
        response,
        200,
        "application/json; charset=utf-8",
        '{"status":"ok"}\n',
      );
      return;
    }
    void handleSubscription(request, response);
  });

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  const drain = (): Promise<0 | 1> => {
    if (drainPromise !== undefined) return drainPromise;
    draining = true;
    drainPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (code: 0 | 1): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve(code);
      };
      server.close(() => {
        finish(0);
      });
      const forceTimer = setTimeout(() => {
        for (const controller of activeControllers) controller.abort();
        for (const connection of connections) connection.destroy();
        server.closeAllConnections();
        finish(1);
      }, options.drainGraceMs ?? DRAIN_GRACE_MS);
      forceTimer.unref();
    });
    return drainPromise;
  };

  return {
    server,
    activeSubscriptions: () => activeSubscriptions,
    drain,
  };
};
