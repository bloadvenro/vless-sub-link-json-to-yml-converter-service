import { stringify } from "yaml";

import { ConversionError } from "./errors.js";
import {
  array,
  boolean,
  checkedString,
  controlFreeString,
  exactObject,
  fail,
  identityString,
  integer,
  literal,
  object,
  oneOf,
  string,
  type JsonObject,
} from "./validation.js";

type MihomoProxy = Record<string, unknown> & { name: string };

interface ClassifiedProfile {
  readonly baseName: string;
  readonly outbound: JsonObject;
}

const AUXILIARY_PROTOCOLS = new Set(["freedom", "blackhole", "loopback"]);
const SUPPORTED_PROTOCOLS = new Set(["vless", "hysteria"]);
const FINGERPRINTS = new Set([
  "firefox",
  "ios",
  "qq",
  "chrome",
  "safari",
  "edge",
  "android",
  "360",
  "random",
  "randomized",
]);
const HYSTERIA_FINGERPRINTS = new Set(["firefox", "randomized"]);
const BBR_PROFILES = new Set(["standard", "conservative", "aggressive"]);
const MAX_AGGREGATE_MATCH_CHECKS = 100_000;
const RESERVED_PROXY_NAMES = new Set([
  "Proxy",
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "COMPATIBLE",
  "PASS",
  "PASS-RULE",
]);

const remarks = (value: unknown): string => {
  const normalized = string(value).normalize("NFC").trim();
  return checkedString(normalized, {
    minBytes: 1,
    maxBytes: 256,
    noControls: true,
  });
};

const proxyShell = (value: JsonObject): JsonObject => {
  const result = exactObject(value, [
    "protocol",
    "settings",
    "streamSettings",
    "tag",
  ]);
  string(result.protocol);
  identityString(result.tag, 256);
  return result;
};

const parseAlpn = (value: unknown): string[] => {
  const values = array(value);
  if (values.length < 1 || values.length > 8) {
    return fail();
  }
  const result = values.map((item) => identityString(item, 64));
  if (new Set(result).size !== result.length) {
    return fail();
  }
  return result;
};

interface TlsSettings {
  readonly alpn: string[];
  readonly fingerprint: string;
  readonly serverName: string;
}

const parseTlsSettings = (value: unknown): TlsSettings => {
  const settings = exactObject(value, ["alpn", "fingerprint", "serverName"]);
  return {
    alpn: parseAlpn(settings.alpn),
    fingerprint: oneOf(settings.fingerprint, FINGERPRINTS),
    serverName: identityString(settings.serverName, 255),
  };
};

const validateSockopt = (value: unknown): void => {
  const sockopt = exactObject(
    value,
    [],
    [
      "tcpMaxSeg",
      "tcpNoDelay",
      "tcpFastOpen",
      "tcpcongestion",
      "tcpUserTimeout",
      "tcpKeepAliveIdle",
      "tcpKeepAliveInterval",
    ],
  );
  if (Object.hasOwn(sockopt, "tcpMaxSeg")) integer(sockopt.tcpMaxSeg, 536, 65_535);
  if (Object.hasOwn(sockopt, "tcpNoDelay")) boolean(sockopt.tcpNoDelay);
  if (Object.hasOwn(sockopt, "tcpFastOpen")) boolean(sockopt.tcpFastOpen);
  if (Object.hasOwn(sockopt, "tcpcongestion")) identityString(sockopt.tcpcongestion, 64);
  if (Object.hasOwn(sockopt, "tcpUserTimeout")) {
    integer(sockopt.tcpUserTimeout, 0, 86_400_000);
  }
  if (Object.hasOwn(sockopt, "tcpKeepAliveIdle")) {
    integer(sockopt.tcpKeepAliveIdle, 0, 86_400);
  }
  if (Object.hasOwn(sockopt, "tcpKeepAliveInterval")) {
    integer(sockopt.tcpKeepAliveInterval, 0, 86_400);
  }
};

interface VlessSettings {
  readonly address: string;
  readonly port: number;
  readonly uuid: string;
  readonly flow: "" | "xtls-rprx-vision";
}

const parseVlessSettings = (value: unknown): VlessSettings => {
  const settings = exactObject(value, ["vnext"]);
  const vnext = array(settings.vnext);
  if (vnext.length !== 1) return fail();
  const endpoint = exactObject(vnext[0], ["address", "port", "users"]);
  const users = array(endpoint.users);
  if (users.length !== 1) return fail();
  const user = exactObject(users[0], ["encryption", "flow", "id"]);
  literal(user.encryption, "none");
  const flow = oneOf(
    user.flow,
    new Set<"" | "xtls-rprx-vision">(["", "xtls-rprx-vision"]),
  );
  return {
    address: identityString(endpoint.address, 255),
    port: integer(endpoint.port, 1, 65_535),
    uuid: identityString(user.id, 128),
    flow,
  };
};

const parseWsSettings = (
  value: unknown,
): { path: string; headers: Record<string, string> } => {
  const settings = exactObject(value, ["path", "headers"]);
  const sourceHeaders = object(settings.headers);
  const headers: Record<string, string> = {};
  Object.setPrototypeOf(headers, null);
  for (const [name, rawValue] of Object.entries(sourceHeaders)) {
    controlFreeString(name, 1, 4_096);
    headers[name] = controlFreeString(rawValue, 0, 4_096);
  }
  return {
    path: controlFreeString(settings.path, 1, 4_096),
    headers,
  };
};

const convertVless = (outbound: JsonObject): Omit<MihomoProxy, "name"> => {
  const connection = parseVlessSettings(outbound.settings);
  const stream = object(outbound.streamSettings);
  const network = string(stream.network);
  const security = string(stream.security);
  const hasSockopt = Object.hasOwn(stream, "sockopt");
  if (hasSockopt) validateSockopt(stream.sockopt);

  const common: Record<string, unknown> = {
    type: "vless",
    server: connection.address,
    port: connection.port,
    uuid: connection.uuid,
    network,
    tls: true,
    udp: true,
    "packet-encoding": "xudp",
  };
  if (connection.flow !== "") common.flow = connection.flow;

  if (network === "tcp" && security === "reality") {
    exactObject(
      stream,
      ["network", "security", "realitySettings"],
      hasSockopt ? ["sockopt", "tcpSettings"] : ["tcpSettings"],
    );
    if (Object.hasOwn(stream, "tcpSettings")) exactObject(stream.tcpSettings, []);
    const reality = exactObject(stream.realitySettings, [
      "fingerprint",
      "publicKey",
      "serverName",
      "shortId",
      "spiderX",
    ]);
    const fingerprint = oneOf(reality.fingerprint, FINGERPRINTS);
    const serverName = identityString(reality.serverName, 255);
    const publicKey = identityString(reality.publicKey, 4_096);
    const shortId = identityString(reality.shortId, 256);
    controlFreeString(reality.spiderX, 0, 4_096);
    return {
      ...common,
      servername: serverName,
      "client-fingerprint": fingerprint,
      "reality-opts": {
        "public-key": publicKey,
        "short-id": shortId,
      },
    };
  }

  if (network === "tcp" && security === "tls") {
    exactObject(
      stream,
      ["network", "security", "tlsSettings"],
      hasSockopt ? ["sockopt", "tcpSettings"] : ["tcpSettings"],
    );
    if (Object.hasOwn(stream, "tcpSettings")) exactObject(stream.tcpSettings, []);
    const tls = parseTlsSettings(stream.tlsSettings);
    return {
      ...common,
      servername: tls.serverName,
      "client-fingerprint": tls.fingerprint,
      alpn: tls.alpn,
    };
  }

  if (network === "ws" && security === "tls") {
    exactObject(stream, ["network", "security", "wsSettings", "tlsSettings"], hasSockopt ? ["sockopt"] : []);
    const ws = parseWsSettings(stream.wsSettings);
    const tls = parseTlsSettings(stream.tlsSettings);
    return {
      ...common,
      servername: tls.serverName,
      "client-fingerprint": tls.fingerprint,
      alpn: tls.alpn,
      "ws-opts": ws,
    };
  }

  return fail();
};

const convertHysteria = (outbound: JsonObject): Omit<MihomoProxy, "name"> => {
  const settings = exactObject(outbound.settings, ["address", "port", "version"]);
  const address = identityString(settings.address, 255);
  const port = integer(settings.port, 1, 65_535);
  literal(settings.version, 2);

  const stream = exactObject(outbound.streamSettings, [
    "network",
    "security",
    "hysteriaSettings",
    "tlsSettings",
    "finalmask",
  ]);
  literal(stream.network, "hysteria");
  literal(stream.security, "tls");

  const hysteria = exactObject(stream.hysteriaSettings, ["auth", "version"]);
  const password = controlFreeString(hysteria.auth, 1, 4_096);
  literal(hysteria.version, 2);

  const tls = parseTlsSettings(stream.tlsSettings);
  oneOf(tls.fingerprint, HYSTERIA_FINGERPRINTS);

  const finalmask = exactObject(stream.finalmask, ["quicParams"]);
  const quic = exactObject(finalmask.quicParams, [
    "bbrProfile",
    "congestion",
    "debug",
    "initConnectionReceiveWindow",
    "initStreamReceiveWindow",
    "keepAlivePeriod",
    "maxConnectionReceiveWindow",
    "maxIdleTimeout",
    "maxIncomingStreams",
    "maxStreamReceiveWindow",
  ]);
  const bbrProfile = oneOf(quic.bbrProfile, BBR_PROFILES);
  literal(quic.congestion, "bbr");
  literal(quic.debug, false);
  literal(quic.maxIdleTimeout, 30);
  literal(quic.keepAlivePeriod, 15);
  literal(quic.maxIncomingStreams, 1_024);

  return {
    type: "hysteria2",
    server: address,
    port,
    password,
    sni: tls.serverName,
    alpn: tls.alpn,
    "bbr-profile": bbrProfile,
    "initial-stream-receive-window": integer(
      quic.initStreamReceiveWindow,
      1,
      2_147_483_647,
    ),
    "max-stream-receive-window": integer(
      quic.maxStreamReceiveWindow,
      1,
      2_147_483_647,
    ),
    "initial-connection-receive-window": integer(
      quic.initConnectionReceiveWindow,
      1,
      2_147_483_647,
    ),
    "max-connection-receive-window": integer(
      quic.maxConnectionReceiveWindow,
      1,
      2_147_483_647,
    ),
  };
};

const validateConvertibleProxy = (outbound: JsonObject): void => {
  const protocol = string(outbound.protocol);
  if (protocol === "vless") {
    convertVless(outbound);
    return;
  }
  if (protocol === "hysteria") {
    convertHysteria(outbound);
    return;
  }
  return fail();
};

const selectors = (value: unknown): string[] => {
  const result = array(value).map((item) => identityString(item, 256));
  if (result.length === 0) return fail();
  return result;
};

interface AggregateMatchBudget {
  used: number;
}

interface AggregateBalancer {
  readonly observational: boolean;
  readonly prefixes: readonly string[];
  readonly tag: string;
}

const parseAggregateBalancer = (
  value: unknown,
  knownOutboundTags: ReadonlySet<string>,
): AggregateBalancer => {
  const balancer = exactObject(value, ["selector", "tag"], ["fallbackTag", "strategy"]);
  const tag = identityString(balancer.tag, 256);
  const prefixes = selectors(balancer.selector);

  if (Object.hasOwn(balancer, "fallbackTag")) {
    const fallbackTag = identityString(balancer.fallbackTag, 256);
    if (!knownOutboundTags.has(fallbackTag)) return fail();
  }

  let strategyType = "random";
  if (Object.hasOwn(balancer, "strategy")) {
    const strategy = exactObject(balancer.strategy, ["type"], ["settings"]);
    strategyType = oneOf(
      strategy.type,
      new Set(["random", "roundRobin", "leastPing", "leastLoad"]),
    );
    if (strategyType === "leastLoad") {
      if (Object.hasOwn(strategy, "settings")) object(strategy.settings);
    } else if (Object.hasOwn(strategy, "settings")) {
      return fail();
    }
  }

  return {
    observational: strategyType === "leastPing" || strategyType === "leastLoad",
    prefixes,
    tag,
  };
};

const reserveMatchChecks = (
  budget: AggregateMatchBudget,
  proxyCount: number,
  prefixCount: number,
): void => {
  if (
    prefixCount >
    Math.floor((MAX_AGGREGATE_MATCH_CHECKS - budget.used) / proxyCount)
  ) {
    return fail();
  }
  budget.used += proxyCount * prefixCount;
};

const accumulateBalancerCoverage = (
  prefixes: readonly string[],
  proxyTags: readonly string[],
  covered: Set<string>,
): void => {
  const matchedPrefixes = prefixes.map(() => false);
  let selectedCount = 0;
  for (const proxyTag of proxyTags) {
    let selected = false;
    for (const [index, prefix] of prefixes.entries()) {
      if (!proxyTag.startsWith(prefix)) continue;
      matchedPrefixes[index] = true;
      selected = true;
    }
    if (selected) {
      selectedCount += 1;
      covered.add(proxyTag);
    }
  }
  if (selectedCount < 2 || matchedPrefixes.some((matched) => !matched)) {
    return fail();
  }
};

const validateObservatory = (
  value: unknown,
  proxyTags: readonly string[],
  burst: boolean,
  matchBudget: AggregateMatchBudget,
): void => {
  const observatory = object(value);
  if (!Object.hasOwn(observatory, "subjectSelector")) return fail();
  const prefixes = selectors(observatory.subjectSelector);
  if (burst) {
    if (!Object.hasOwn(observatory, "pingConfig")) return fail();
    object(observatory.pingConfig);
  }
  reserveMatchChecks(matchBudget, proxyTags.length, prefixes.length);
  for (const prefix of prefixes) {
    if (!proxyTags.some((tag) => tag.startsWith(prefix))) return fail();
  }
};

const isIgnoredAggregate = (
  profile: JsonObject,
  outbounds: readonly JsonObject[],
  proxies: readonly JsonObject[],
  matchBudget: AggregateMatchBudget,
): boolean => {
  if (proxies.length < 2) return false;

  const proxyTags = proxies.map((proxy) => identityString(proxy.tag, 256));
  if (new Set(proxyTags).size !== proxyTags.length) return fail();
  for (const proxy of proxies) validateConvertibleProxy(proxy);

  const knownOutboundTags = new Set(proxyTags);
  for (const outbound of outbounds) {
    if (!SUPPORTED_PROTOCOLS.has(string(outbound.protocol)) && Object.hasOwn(outbound, "tag")) {
      const tag = identityString(outbound.tag, 256);
      if (knownOutboundTags.has(tag)) return fail();
      knownOutboundTags.add(tag);
    }
  }

  const routing = object(profile.routing);
  const rawBalancers = array(routing.balancers);
  if (rawBalancers.length === 0) return fail();
  const knownBalancerTags = new Set<string>();
  const covered = new Set<string>();
  let hasObservationalStrategy = false;
  for (const rawBalancer of rawBalancers) {
    const balancer = parseAggregateBalancer(
      rawBalancer,
      knownOutboundTags,
    );
    if (knownBalancerTags.has(balancer.tag)) return fail();
    knownBalancerTags.add(balancer.tag);
    hasObservationalStrategy ||= balancer.observational;
    reserveMatchChecks(matchBudget, proxyTags.length, balancer.prefixes.length);
    accumulateBalancerCoverage(balancer.prefixes, proxyTags, covered);
  }
  if (covered.size !== proxyTags.length) return fail();

  const referencedBalancerTags = new Set<string>();
  for (const rawRule of array(routing.rules)) {
    const rule = object(rawRule);
    if (Object.hasOwn(rule, "outboundTag")) {
      identityString(rule.outboundTag, 256);
      continue;
    }
    if (!Object.hasOwn(rule, "balancerTag")) return fail();
    const balancerTag = identityString(rule.balancerTag, 256);
    if (!knownBalancerTags.has(balancerTag)) return fail();
    referencedBalancerTags.add(balancerTag);
  }
  if (referencedBalancerTags.size !== knownBalancerTags.size) return fail();

  const hasObservatory = Object.hasOwn(profile, "observatory");
  const hasBurstObservatory = Object.hasOwn(profile, "burstObservatory");
  if (hasObservatory && hasBurstObservatory) return fail();
  if (hasObservationalStrategy && !hasObservatory && !hasBurstObservatory) {
    return fail();
  }
  if (hasObservatory || hasBurstObservatory) {
    validateObservatory(
      hasObservatory ? profile.observatory : profile.burstObservatory,
      proxyTags,
      hasBurstObservatory,
      matchBudget,
    );
  }
  return true;
};

const classifyProfile = (
  value: unknown,
  matchBudget: AggregateMatchBudget,
): ClassifiedProfile | undefined => {
  const profile = object(value);
  if (!Object.hasOwn(profile, "remarks") || !Object.hasOwn(profile, "outbounds")) {
    return fail();
  }
  const baseName = remarks(profile.remarks);
  const outbounds = array(profile.outbounds).map(object);
  const proxies: JsonObject[] = [];

  for (const outbound of outbounds) {
    const protocol = string(outbound.protocol);
    if (!AUXILIARY_PROTOCOLS.has(protocol)) {
      proxies.push(proxyShell(outbound));
    }
  }

  if (proxies.length === 1) {
    const outbound = proxies[0] ?? fail();
    if (!SUPPORTED_PROTOCOLS.has(string(outbound.protocol))) return fail();
    return { baseName, outbound };
  }
  if (isIgnoredAggregate(profile, outbounds, proxies, matchBudget)) {
    return undefined;
  }
  return fail();
};

const assignNames = (baseNames: readonly string[]): string[] => {
  const prescanned = new Set(baseNames);
  const emitted = new Set<string>();
  const occurrences = new Map<string, number>();
  const nextSuffixes = new Map<string, number>();

  return baseNames.map((baseName) => {
    const occurrence = (occurrences.get(baseName) ?? 0) + 1;
    occurrences.set(baseName, occurrence);
    if (occurrence === 1 && !RESERVED_PROXY_NAMES.has(baseName)) {
      emitted.add(baseName);
      return baseName;
    }

    for (let suffix = nextSuffixes.get(baseName) ?? 2; ; suffix += 1) {
      const candidate = `${baseName} #${suffix}`;
      if (
        !RESERVED_PROXY_NAMES.has(candidate) &&
        !prescanned.has(candidate) &&
        !emitted.has(candidate)
      ) {
        nextSuffixes.set(baseName, suffix + 1);
        emitted.add(candidate);
        return candidate;
      }
    }
  });
};

export interface MihomoConfig {
  readonly proxies: MihomoProxy[];
  readonly "proxy-groups": Array<{
    readonly name: "Proxy";
    readonly type: "select";
    readonly proxies: string[];
  }>;
  readonly rules: ["MATCH,Proxy"];
}

export const convertHappJson = (value: unknown): MihomoConfig => {
  const profiles = array(value);
  if (profiles.length === 0) return fail();
  const matchBudget: AggregateMatchBudget = { used: 0 };
  const standalone = profiles
    .map((profile) => classifyProfile(profile, matchBudget))
    .filter((profile): profile is ClassifiedProfile => profile !== undefined);
  if (standalone.length === 0) return fail();

  const names = assignNames(standalone.map((profile) => profile.baseName));
  const proxies = standalone.map((profile, index) => {
    const converted =
      profile.outbound.protocol === "vless"
        ? convertVless(profile.outbound)
        : convertHysteria(profile.outbound);
    return { name: names[index] ?? fail(), ...converted };
  });

  return {
    proxies,
    "proxy-groups": [{ name: "Proxy", type: "select", proxies: names }],
    rules: ["MATCH,Proxy"],
  };
};

export const convertHappText = (body: Uint8Array | string): string => {
  let parsed: unknown;
  try {
    const text =
      typeof body === "string"
        ? body
        : new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text);
  } catch {
    throw new ConversionError();
  }
  return stringify(convertHappJson(parsed), { lineWidth: 0 });
};
