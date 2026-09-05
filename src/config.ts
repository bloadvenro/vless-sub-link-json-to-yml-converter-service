import { validateHeaderValue } from "node:http";

export const DEFAULT_USER_AGENT = "Happ/4.3.0/Android";

export interface RuntimeConfig {
  readonly listenPort: number;
  readonly subscriptionUrl: URL;
  readonly userAgent: string;
}

export class ConfigError extends Error {
  constructor(readonly key: "SUBSCRIPTION_URL" | "HAPP_USER_AGENT" | "PORT") {
    super(`Invalid configuration: ${key}`);
    this.name = "ConfigError";
  }
}

const isAsciiWhitespace = (codePoint: number): boolean =>
  codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d);

const trimAsciiWhitespace = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
};

const validHttpsUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
};

export const readConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfig => {
  const rawUrl = environment.SUBSCRIPTION_URL;
  if (rawUrl === undefined) {
    throw new ConfigError("SUBSCRIPTION_URL");
  }

  const subscriptionUrl = validHttpsUrl(trimAsciiWhitespace(rawUrl));
  if (subscriptionUrl === undefined) {
    throw new ConfigError("SUBSCRIPTION_URL");
  }

  const userAgent = trimAsciiWhitespace(
    environment.HAPP_USER_AGENT ?? DEFAULT_USER_AGENT,
  );
  if (userAgent === "" || Buffer.byteLength(userAgent, "utf8") > 256) {
    throw new ConfigError("HAPP_USER_AGENT");
  }
  try {
    validateHeaderValue("User-Agent", userAgent);
  } catch {
    throw new ConfigError("HAPP_USER_AGENT");
  }

  const rawPort = environment.PORT ?? "17890";
  if (!/^\d+$/u.test(rawPort)) {
    throw new ConfigError("PORT");
  }
  const listenPort = Number(rawPort);
  if (!Number.isSafeInteger(listenPort) || listenPort > 65_535) {
    throw new ConfigError("PORT");
  }

  return { listenPort, subscriptionUrl, userAgent };
};

export const validateRedirectUrl = (location: string, base: URL): URL => {
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    throw new Error("invalid redirect");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid redirect");
  }
  return url;
};
