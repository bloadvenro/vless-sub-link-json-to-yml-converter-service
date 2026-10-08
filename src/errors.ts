export type ConversionFailureReason = "invalid-utf8" | "invalid-json" | "schema-validation";
export type ValidationIssue = "missing-fields" | "unknown-fields";

export class ConversionError extends Error {
  constructor(
    readonly reason: ConversionFailureReason = "schema-validation",
    readonly validationIssue?: ValidationIssue,
  ) {
    super("Invalid subscription");
    this.name = "ConversionError";
  }
}

export type UpstreamFailureKind = "bad-gateway" | "timeout";
export type UpstreamFailureReason =
  | "http-status"
  | "redirect-missing"
  | "redirect-invalid"
  | "redirect-limit"
  | "body-too-large"
  | "fetch-network"
  | "body-read"
  | "timeout";

const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

// Only standardized codes are useful diagnostics; messages and other cause fields stay private.
export const safeNetworkCodeValue = (value: unknown): string | undefined =>
  typeof value === "string" && NETWORK_CODES.has(value) ? value : undefined;

export const safeNetworkCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return safeNetworkCodeValue(cause.code);
};

export interface UpstreamDiagnostics {
  readonly reason: UpstreamFailureReason;
  readonly upstreamStatus?: number;
  readonly redirects?: number;
  readonly networkCode?: string;
}

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamFailureKind,
    readonly diagnostics?: UpstreamDiagnostics,
  ) {
    super(kind);
    this.name = "UpstreamError";
  }
}

export class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted");
    this.name = "RequestAbortedError";
  }
}
