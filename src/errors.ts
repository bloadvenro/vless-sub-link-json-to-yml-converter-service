export class ConversionError extends Error {
  constructor() {
    super("Invalid subscription");
    this.name = "ConversionError";
  }
}

export type UpstreamFailureKind = "bad-gateway" | "timeout";

export class UpstreamError extends Error {
  constructor(readonly kind: UpstreamFailureKind) {
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
