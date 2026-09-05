import { validateHeaderValue } from "node:http";

import { validateRedirectUrl } from "./config.js";
import { RequestAbortedError, UpstreamError } from "./errors.js";

const MAX_BODY_BYTES = 5 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_HEADERS = [
  "subscription-userinfo",
  "profile-update-interval",
  "profile-web-page-url",
  "content-disposition",
] as const;

export interface UpstreamResult {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
}

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after the response has already failed validation.
  }
};

const readBody = async (
  response: Response,
  controller: AbortController,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    BigInt(contentLength) > BigInt(MAX_BODY_BYTES)
  ) {
    await cancelBody(response);
    controller.abort();
    throw new UpstreamError("bad-gateway");
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        controller.abort();
        await reader.cancel();
        throw new UpstreamError("bad-gateway");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

const safeForwardedHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  let combinedBytes = 0;
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > 4_096 || combinedBytes + bytes > 8_192) continue;
    try {
      validateHeaderValue(name, value);
    } catch {
      continue;
    }
    result[name] = value;
    combinedBytes += bytes;
  }
  return result;
};

export const fetchSubscription = async (
  initialUrl: URL,
  userAgent: string,
  requestSignal: AbortSignal,
  options: FetchOptions = {},
): Promise<UpstreamResult> => {
  const controller = new AbortController();
  const timeoutReason = Symbol("upstream-timeout");
  const abortFromRequest = (): void => {
    controller.abort(requestSignal.reason);
  };
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(timeoutReason);
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    let currentUrl = initialUrl;
    let redirectCount = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": userAgent,
            Accept: "application/json",
            "Accept-Encoding": "identity",
          },
          signal: controller.signal,
        });
      } catch {
        if (requestSignal.aborted) throw new RequestAbortedError();
        if (controller.signal.reason === timeoutReason) {
          throw new UpstreamError("timeout");
        }
        throw new UpstreamError("bad-gateway");
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= 3) {
          await cancelBody(response);
          throw new UpstreamError("bad-gateway");
        }
        const location = response.headers.get("location");
        if (location === null) {
          await cancelBody(response);
          throw new UpstreamError("bad-gateway");
        }
        try {
          currentUrl = validateRedirectUrl(location, currentUrl);
        } catch {
          await cancelBody(response);
          throw new UpstreamError("bad-gateway");
        }
        await cancelBody(response);
        redirectCount += 1;
        continue;
      }

      if (response.status !== 200) {
        await cancelBody(response);
        throw new UpstreamError("bad-gateway");
      }

      try {
        return {
          body: await readBody(response, controller),
          headers: safeForwardedHeaders(response.headers),
        };
      } catch (error) {
        if (requestSignal.aborted) throw new RequestAbortedError();
        if (controller.signal.reason === timeoutReason) {
          throw new UpstreamError("timeout");
        }
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError("bad-gateway");
      }
    }
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortFromRequest);
  }
};
