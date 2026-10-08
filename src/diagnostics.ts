import { ConversionError, safeNetworkCodeValue, UpstreamError } from "./errors.js";

const UPSTREAM_REASONS = new Set([
  "http-status", "redirect-missing", "redirect-invalid", "redirect-limit",
  "body-too-large", "fetch-network", "body-read", "timeout",
]);
const CONVERSION_REASONS = new Set(["invalid-utf8", "invalid-json", "schema-validation"]);
const CONVERSION_FUNCTIONS = new Set([
  "parseAlpn", "parseTlsSettings", "validateSockopt", "parseVlessSettings",
  "parseWsSettings", "convertVless", "convertHysteria", "validateConvertibleProxy",
  "parseAggregateBalancer", "validateObservatory", "isIgnoredAggregate",
  "classifyProfile", "convertHappJson",
]);

type LogContext = Record<string, string | number>;

export const failureContext = (error: unknown): LogContext => {
  if (error instanceof UpstreamError) {
    const details = error.diagnostics;
    const result: LogContext = {
      reason: details !== undefined && UPSTREAM_REASONS.has(details.reason)
        ? details.reason
        : error.kind === "timeout" ? "timeout" : "unknown",
    };
    if (details === undefined) return result;
    const status = details.upstreamStatus;
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      result.upstream_status = status;
    }
    const redirects = details.redirects;
    if (redirects !== undefined && Number.isInteger(redirects) && redirects >= 0 && redirects <= 3) {
      result.redirects = redirects;
    }
    const code = safeNetworkCodeValue(details.networkCode);
    if (code !== undefined) result.network_code = code;
    return result;
  }
  if (error instanceof ConversionError) {
    const result: LogContext = {
      reason: CONVERSION_REASONS.has(error.reason) ? error.reason : "schema-validation",
    };
    if (error.validationIssue === "missing-fields" || error.validationIssue === "unknown-fields") {
      result.validation_issue = error.validationIssue;
    }
    if (result.reason !== "schema-validation") return result;
    // Extract only a known local function and bounded line number; never emit the raw stack/path.
    for (const frame of (error.stack ?? "").slice(0, 8_192).split("\n").slice(1, 12)) {
      const match = /^\s+at (\w+) \([^()\n]*\/src\/converter\.(?:js|ts):([1-9]\d{0,3}):\d{1,4}\)$/u.exec(frame);
      if (match?.[1] !== undefined && CONVERSION_FUNCTIONS.has(match[1]) && match[2] !== undefined) {
        result.conversion_function = match[1];
        result.conversion_line = Number(match[2]);
        break;
      }
    }
    return result;
  }
  return { reason: "unexpected" };
};
