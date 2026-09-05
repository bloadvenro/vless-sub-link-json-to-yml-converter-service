import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

import { convertHappJson, convertHappText } from "../src/converter.js";
import { ConversionError } from "../src/errors.js";
import {
  aggregate,
  clone,
  hysteria,
  malformedUtf8Subscription,
  vlessReality,
  vlessTcpTls,
  vlessWsTls,
} from "./fixtures.js";

const firstOutbound = (profile: Record<string, unknown>): Record<string, unknown> =>
  (profile.outbounds as Array<Record<string, unknown>>)[0] as Record<string, unknown>;

const streamSettings = (profile: Record<string, unknown>): Record<string, unknown> =>
  firstOutbound(profile).streamSettings as Record<string, unknown>;

test("converts TCP Reality VLESS and ignores validated sockopt fields", () => {
  const config = convertHappJson([vlessReality()]);
  assert.deepEqual(config.proxies, [
    {
      name: "Reality node",
      type: "vless",
      server: "reality.example.test",
      port: 8443,
      uuid: "00000000-0000-4000-8000-000000000002",
      network: "tcp",
      tls: true,
      udp: true,
      "packet-encoding": "xudp",
      flow: "xtls-rprx-vision",
      servername: "reality-sni.example.test",
      "client-fingerprint": "firefox",
      "reality-opts": {
        "public-key": "r6onu6Y0J9A-kTXOc3d-f9Z4eJej-QUrMh8UmTfKvnE",
        "short-id": "0123456789abcdef",
      },
    },
  ]);
});

test("converts TCP TLS VLESS", () => {
  const proxy = convertHappJson([vlessTcpTls()]).proxies[0];
  assert.deepEqual(proxy, {
    name: "TLS node",
    type: "vless",
    server: "tls.example.test",
    port: 443,
    uuid: "00000000-0000-4000-8000-000000000001",
    network: "tcp",
    tls: true,
    udp: true,
    "packet-encoding": "xudp",
    servername: "sni.example.test",
    "client-fingerprint": "chrome",
    alpn: ["h2", "http/1.1"],
  });
});

test("accepts omitted empty tcpSettings for both TCP variants with equivalent output", () => {
  for (const fixture of [vlessReality, vlessTcpTls]) {
    const withTcpSettings = fixture();
    const withoutTcpSettings = clone(withTcpSettings);
    delete streamSettings(withoutTcpSettings).tcpSettings;
    assert.deepEqual(
      convertHappJson([withoutTcpSettings]),
      convertHappJson([withTcpSettings]),
    );

    const nonemptyTcpSettings = clone(withTcpSettings);
    streamSettings(nonemptyTcpSettings).tcpSettings = { unexpected: true };
    assert.throws(
      () => convertHappJson([nonemptyTcpSettings]),
      ConversionError,
    );
  }

  const wsWithTcpSettings = vlessWsTls();
  streamSettings(wsWithTcpSettings).tcpSettings = {};
  assert.throws(() => convertHappJson([wsWithTcpSettings]), ConversionError);
});

test("converts WS TLS VLESS while preserving semantic strings", () => {
  const proxy = convertHappJson([vlessWsTls()]).proxies[0];
  assert.ok(proxy !== undefined);
  const wsOptions = proxy["ws-opts"] as {
    headers: Record<string, string>;
    path: string;
  };
  assert.equal(wsOptions.path, "/socket?ed=2048");
  assert.equal(Object.getPrototypeOf(wsOptions.headers), null);
  assert.deepEqual(Object.entries(wsOptions.headers), [
    ["Host", "front.example.test"],
    ["X-Synthetic", "  preserved value  "],
  ]);
});

test("accepts the 360 client fingerprint for every supported VLESS transport", () => {
  for (const fixture of [vlessReality, vlessTcpTls, vlessWsTls]) {
    const profile = fixture();
    const stream = streamSettings(profile);
    const security = stream.security;
    const tls = (security === "reality"
      ? stream.realitySettings
      : stream.tlsSettings) as Record<string, unknown>;
    tls.fingerprint = "360";
    assert.equal(
      convertHappJson([profile]).proxies[0]?.["client-fingerprint"],
      "360",
    );
  }

  const unsupportedHysteriaFingerprint = hysteria();
  const tls = streamSettings(unsupportedHysteriaFingerprint)
    .tlsSettings as Record<string, unknown>;
  tls.fingerprint = "360";
  assert.throws(
    () => convertHappJson([unsupportedHysteriaFingerprint]),
    ConversionError,
  );
});

test("keeps VLESS client fingerprints as a closed set", () => {
  for (const fixture of [vlessReality, vlessTcpTls, vlessWsTls]) {
    const profile = fixture();
    const stream = streamSettings(profile);
    const tls = (stream.security === "reality"
      ? stream.realitySettings
      : stream.tlsSettings) as Record<string, unknown>;
    tls.fingerprint = "unsupported-browser";
    assert.throws(() => convertHappJson([profile]), ConversionError);
  }
});

test("converts Hysteria 2 and deliberately omits the client fingerprint", () => {
  const proxy = convertHappJson([hysteria()]).proxies[0];
  assert.deepEqual(proxy, {
    name: "Hysteria node",
    type: "hysteria2",
    server: "hy.example.test",
    port: 443,
    password: "  preserved password  ",
    sni: "hy-sni.example.test",
    alpn: ["h3"],
    "bbr-profile": "aggressive",
    "initial-stream-receive-window": 4_194_304,
    "max-stream-receive-window": 8_388_608,
    "initial-connection-receive-window": 8_388_608,
    "max-connection-receive-window": 16_777_216,
  });
  assert.equal(Object.hasOwn(proxy, "client-fingerprint"), false);
});

test("ignores recognized aggregates and their nested client sections", () => {
  const config = convertHappJson([aggregate(), vlessTcpTls("Standalone")]);
  assert.deepEqual(config["proxy-groups"][0]?.proxies, ["Standalone"]);
});

test("accepts burst observation and observation-free random strategies", () => {
  const burst = aggregate();
  burst.burstObservatory = {
    ...(burst.observatory as Record<string, unknown>),
    pingConfig: {},
  };
  delete burst.observatory;
  const burstBalancer = ((burst.routing as Record<string, unknown>)
    .balancers as Array<Record<string, unknown>>)[0];
  assert.ok(burstBalancer !== undefined);
  burstBalancer.strategy = { type: "leastLoad", settings: {} };

  const implicitRandom = aggregate();
  delete implicitRandom.observatory;
  const implicitBalancer = ((implicitRandom.routing as Record<string, unknown>)
    .balancers as Array<Record<string, unknown>>)[0];
  assert.ok(implicitBalancer !== undefined);
  delete implicitBalancer.strategy;

  const roundRobin = aggregate();
  delete roundRobin.observatory;
  const roundRobinBalancer = ((roundRobin.routing as Record<string, unknown>)
    .balancers as Array<Record<string, unknown>>)[0];
  assert.ok(roundRobinBalancer !== undefined);
  roundRobinBalancer.strategy = { type: "roundRobin" };

  const partialObservation = aggregate();
  (partialObservation.observatory as Record<string, unknown>).subjectSelector = [
    "proxy-one",
  ];

  const duplicateSelectors = aggregate();
  const duplicateSelectorBalancer = ((duplicateSelectors.routing as Record<
    string,
    unknown
  >).balancers as Array<Record<string, unknown>>)[0];
  assert.ok(duplicateSelectorBalancer !== undefined);
  duplicateSelectorBalancer.selector = ["proxy-", "proxy-"];

  const leastLoadDefaults = aggregate();
  const leastLoadBalancer = ((leastLoadDefaults.routing as Record<string, unknown>)
    .balancers as Array<Record<string, unknown>>)[0];
  assert.ok(leastLoadBalancer !== undefined);
  leastLoadBalancer.strategy = { type: "leastLoad" };

  const outboundPrecedence = aggregate();
  (outboundPrecedence.routing as Record<string, unknown>).rules = [
    { balancerTag: "unknown", outboundTag: "provider-only-outbound" },
    { balancerTag: "automatic" },
  ];

  for (const recognized of [
    burst,
    implicitRandom,
    roundRobin,
    partialObservation,
    duplicateSelectors,
    leastLoadDefaults,
    outboundPrecedence,
  ]) {
    assert.doesNotThrow(() =>
      convertHappJson([recognized, vlessTcpTls("Standalone")]),
    );
  }
});

test("accepts two fully referenced balancers whose union covers all proxies", () => {
  const profile = aggregate();
  const routing = profile.routing as Record<string, unknown>;
  routing.balancers = [
    { selector: ["proxy-one", "proxy-two"], tag: "first" },
    {
      selector: ["proxy-two", "proxy-three"],
      strategy: { type: "leastLoad", settings: {} },
      tag: "second",
    },
  ];
  routing.rules = [{ balancerTag: "first" }, { balancerTag: "second" }];
  assert.doesNotThrow(() =>
    convertHappJson([profile, vlessTcpTls("Standalone")]),
  );
});

test("requires complete aggregate balancer coverage and valid routing references", () => {
  const mutations: Array<(profile: Record<string, unknown>) => void> = [
    (profile) => {
      (profile.routing as Record<string, unknown>).balancers = [];
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.selector = [];
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.selector = ["proxy-one"];
    },
    (profile) => {
      const routing = profile.routing as Record<string, unknown>;
      routing.balancers = [
        { selector: ["proxy-one", "proxy-two"], tag: "partial" },
      ];
      routing.rules = [{ balancerTag: "partial" }];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [
        { balancerTag: "unknown" },
      ];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [
        { outboundTag: null },
        { balancerTag: "automatic" },
      ];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [
        { outboundTag: "" },
        { balancerTag: "automatic" },
      ];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [
        { type: "field" },
        { balancerTag: "automatic" },
      ];
    },
    (profile) => {
      (profile.routing as Record<string, unknown>).rules = [
        { balancerTag: "automatic", outboundTag: "proxy-one" },
      ];
    },
    (profile) => {
      const routing = profile.routing as Record<string, unknown>;
      const original = (routing.balancers as unknown[])[0];
      routing.balancers = [original, clone(original)];
      routing.rules = [{ balancerTag: "automatic" }];
    },
    (profile) => {
      const routing = profile.routing as Record<string, unknown>;
      const second = clone(
        (routing.balancers as Array<Record<string, unknown>>)[0],
      );
      assert.ok(second !== undefined);
      second.tag = "secondary";
      routing.balancers = [
        (routing.balancers as unknown[])[0],
        second,
      ];
      routing.rules = [{ balancerTag: "automatic" }];
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.selector = ["proxy-", "missing"];
    },
  ];

  for (const mutate of mutations) {
    const malformed = aggregate();
    mutate(malformed);
    assert.throws(
      () => convertHappJson([malformed, vlessTcpTls("Standalone")]),
      ConversionError,
    );
  }
});

test("validates aggregate proxy tags, fallback references, and proxy payloads", () => {
  const validFallbacks = ["proxy-one", "loop"];
  for (const fallbackTag of validFallbacks) {
    const profile = aggregate();
    const balancer = ((profile.routing as Record<string, unknown>)
      .balancers as Array<Record<string, unknown>>)[0];
    assert.ok(balancer !== undefined);
    balancer.fallbackTag = fallbackTag;
    assert.doesNotThrow(() =>
      convertHappJson([profile, vlessTcpTls("Standalone")]),
    );
  }

  const mutations: Array<(profile: Record<string, unknown>) => void> = [
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      assert.ok(outbounds[1] !== undefined);
      outbounds[1].tag = "proxy-one";
    },
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      assert.ok(outbounds[1] !== undefined);
      outbounds[1].tag = "";
    },
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      const settings = outbounds[0]?.settings as Record<string, unknown>;
      settings.unknown = true;
    },
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      assert.ok(outbounds[0] !== undefined);
      outbounds[0].protocol = "trojan";
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.fallbackTag = "missing";
    },
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      outbounds.push({ protocol: "blackhole", tag: "loop" });
    },
    (profile) => {
      const outbounds = profile.outbounds as Array<Record<string, unknown>>;
      const auxiliary = outbounds.at(-1);
      assert.ok(auxiliary !== undefined);
      auxiliary.tag = "proxy-one";
    },
  ];

  for (const mutate of mutations) {
    const malformed = aggregate();
    mutate(malformed);
    assert.throws(
      () => convertHappJson([malformed, vlessTcpTls("Standalone")]),
      ConversionError,
    );
  }
});

test("enforces aggregate strategy and observatory compatibility", () => {
  const mutations: Array<(profile: Record<string, unknown>) => void> = [
    (profile) => {
      delete profile.observatory;
    },
    (profile) => {
      profile.burstObservatory = clone(profile.observatory);
    },
    (profile) => {
      profile.burstObservatory = {
        ...(profile.observatory as Record<string, unknown>),
      };
      delete profile.observatory;
    },
    (profile) => {
      profile.burstObservatory = {
        ...(profile.observatory as Record<string, unknown>),
        pingConfig: [],
      };
      delete profile.observatory;
    },
    (profile) => {
      (profile.observatory as Record<string, unknown>).subjectSelector = [
        "missing",
      ];
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.strategy = { type: "unsupported" };
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.strategy = { type: "leastPing", settings: {} };
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.strategy = { type: "random", settings: {} };
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.strategy = { type: "roundRobin", settings: {} };
    },
    (profile) => {
      const balancer = ((profile.routing as Record<string, unknown>)
        .balancers as Array<Record<string, unknown>>)[0];
      assert.ok(balancer !== undefined);
      balancer.strategy = { type: "leastLoad", settings: [] };
    },
  ];

  for (const mutate of mutations) {
    const malformed = aggregate();
    mutate(malformed);
    assert.throws(
      () => convertHappJson([malformed, vlessTcpTls("Standalone")]),
      ConversionError,
    );
  }
});

test("bounds request-wide aggregate tag-prefix comparisons at 100,000", () => {
  const makeAggregate = (
    label: string,
    overHalfLimit: boolean,
  ): Record<string, unknown> => {
    const profile = aggregate();
    profile.remarks = `Bounded ${label}`;
    delete profile.observatory;
    const template = (profile.outbounds as Array<Record<string, unknown>>)[0];
    assert.ok(template !== undefined);
    const proxyOutbounds = Array.from({ length: 100 }, (_, index) => {
      const outbound = clone(template);
      outbound.tag = `${label}-node-${index}-${"x".repeat(8)}`;
      return outbound;
    });
    const prefixes = proxyOutbounds.flatMap((outbound) => {
      const tag = outbound.tag as string;
      const baseLength = tag.indexOf("x");
      return Array.from({ length: 5 }, (_, index) =>
        tag.slice(0, baseLength + index + 1),
      );
    });
    if (overHalfLimit) {
      const firstTag = proxyOutbounds[0]?.tag as string;
      prefixes.push(firstTag.slice(0, firstTag.indexOf("x") + 6));
    }
    profile.outbounds = [
      ...proxyOutbounds,
      { protocol: "loopback", tag: "loop" },
    ];
    profile.routing = {
      balancers: [{ selector: prefixes, tag: "bounded" }],
      rules: [{ balancerTag: "bounded" }],
    };
    return profile;
  };

  assert.doesNotThrow(() =>
    convertHappJson([
      makeAggregate("first", false),
      makeAggregate("second", false),
      vlessTcpTls("Standalone"),
    ]),
  );
  assert.throws(
    () =>
      convertHappJson([
        makeAggregate("first", false),
        makeAggregate("second", true),
        vlessTcpTls("Standalone"),
      ]),
    ConversionError,
  );
});

test("keeps whole-feed fail-closed semantics for malformed aggregates", () => {
  const unsupported = vlessTcpTls();
  firstOutbound(unsupported).protocol = "trojan";
  for (const value of [
    [],
    [aggregate()],
    [unsupported],
    [vlessTcpTls("Standalone"), { remarks: "none", outbounds: [] }],
  ]) {
    assert.throws(() => convertHappJson(value), ConversionError);
  }
});

test("uses the specified pre-scanned collision algorithm", () => {
  const profiles = ["A", "A", "A #2", "Proxy"].map((name) => vlessTcpTls(name));
  const config = convertHappJson(profiles);
  assert.deepEqual(config.proxies.map((proxy) => proxy.name), [
    "A",
    "A #3",
    "A #2",
    "Proxy #2",
  ]);
  assert.deepEqual(config["proxy-groups"][0]?.proxies, [
    "A",
    "A #3",
    "A #2",
    "Proxy #2",
  ]);
});

test("suffixes every Mihomo-reserved name and skips raw suffixed collisions", () => {
  const baseNames = [
    "Proxy",
    "DIRECT",
    "REJECT",
    "REJECT-DROP",
    "COMPATIBLE",
    "PASS",
    "PASS-RULE",
    "DIRECT #2",
    "DIRECT",
  ];
  const config = convertHappJson(baseNames.map((name) => vlessTcpTls(name)));
  const expected = [
    "Proxy #2",
    "DIRECT #3",
    "REJECT #2",
    "REJECT-DROP #2",
    "COMPATIBLE #2",
    "PASS #2",
    "PASS-RULE #2",
    "DIRECT #2",
    "DIRECT #4",
  ];
  assert.deepEqual(config.proxies.map((proxy) => proxy.name), expected);
  assert.deepEqual(config["proxy-groups"][0]?.proxies, expected);
});

test("preserves first-available suffixes across adversarial nested collisions", () => {
  const baseNames = [
    "Node",
    "Node",
    "Node #2",
    "Node #3",
    "Node",
    "Node #2",
    "Node #2 #2",
    "Node #2",
    "DIRECT",
    "DIRECT #2",
    "DIRECT",
  ];
  const config = convertHappJson(baseNames.map((name) => vlessTcpTls(name)));
  const expected = [
    "Node",
    "Node #4",
    "Node #2",
    "Node #3",
    "Node #5",
    "Node #2 #3",
    "Node #2 #2",
    "Node #2 #4",
    "DIRECT #3",
    "DIRECT #2",
    "DIRECT #4",
  ];
  assert.deepEqual(config.proxies.map((proxy) => proxy.name), expected);
  assert.deepEqual(config["proxy-groups"][0]?.proxies, expected);
});

test(
  "assigns a large run of identical names without quadratic suffix rescans",
  () => {
    const count = 10_000;
    const probe = String.raw`
      const [converterUrl, fixturesUrl, countText] = process.argv.slice(1);
      const [{ convertHappJson }, { vlessTcpTls }] = await Promise.all([
        import(converterUrl),
        import(fixturesUrl),
      ]);
      const count = Number.parseInt(countText, 10);
      const config = convertHappJson(
        Array.from({ length: count }, () => vlessTcpTls("Repeated")),
      );
      const names = config.proxies.map((proxy) => proxy.name);
      process.stdout.write(JSON.stringify({
        names,
        groupNames: config["proxy-groups"][0]?.proxies,
      }));
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        probe,
        new URL("../src/converter.js", import.meta.url).href,
        new URL("./fixtures.js", import.meta.url).href,
        String(count),
      ],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
        timeout: 10_000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout) as {
      groupNames: string[] | undefined;
      names: string[];
    };
    const { groupNames, names } = output;

    assert.equal(names.length, count);
    assert.deepEqual(names.slice(0, 4), [
      "Repeated",
      "Repeated #2",
      "Repeated #3",
      "Repeated #4",
    ]);
    assert.equal(names.at(-1), `Repeated #${count}`);
    assert.equal(new Set(names).size, count);
    assert.deepEqual(groupNames, names);
  },
);

test("normalizes and trims remarks but preserves duplicate endpoints", () => {
  const first = vlessTcpTls("  Cafe\u0301  ");
  const second = vlessTcpTls("Café");
  const config = convertHappJson([first, second]);
  assert.deepEqual(config.proxies.map((proxy) => proxy.name), ["Café", "Café #2"]);
  assert.equal(config.proxies[0]?.server, config.proxies[1]?.server);
});

test("rejects control characters remaining in normalized and trimmed remarks", () => {
  for (const value of ["Node\u0000", "Node\nname", "  Cafe\u0301\u007f  "]) {
    assert.throws(() => convertHappJson([vlessTcpTls(value)]), ConversionError);
  }
});

test("enforces Reality identity whitespace and byte limits", () => {
  for (const [key, maximum] of [
    ["publicKey", 4_096],
    ["shortId", 256],
  ] as const) {
    const boundary = clone(vlessReality());
    const boundaryStream = firstOutbound(boundary).streamSettings as Record<string, unknown>;
    const boundaryReality = boundaryStream.realitySettings as Record<string, unknown>;
    boundaryReality[key] = "x".repeat(maximum);
    assert.doesNotThrow(() => convertHappJson([boundary]));

    for (const value of [" leading", "trailing ", "x".repeat(maximum + 1)]) {
      const invalid = clone(vlessReality());
      const stream = firstOutbound(invalid).streamSettings as Record<string, unknown>;
      const reality = stream.realitySettings as Record<string, unknown>;
      reality[key] = value;
      assert.throws(() => convertHappJson([invalid]), ConversionError);
    }
  }
});

test("requires WS header names and preserves special keys in a null-prototype record", () => {
  const emptyName = clone(vlessWsTls());
  const emptyNameStream = firstOutbound(emptyName).streamSettings as Record<string, unknown>;
  const emptyNameWs = emptyNameStream.wsSettings as Record<string, unknown>;
  emptyNameWs.headers = { "": "value" };
  assert.throws(() => convertHappJson([emptyName]), ConversionError);

  const specialNames = clone(vlessWsTls());
  const specialStream = firstOutbound(specialNames).streamSettings as Record<string, unknown>;
  const specialWs = specialStream.wsSettings as Record<string, unknown>;
  specialWs.headers = JSON.parse(
    '{"__proto__":"proto value","prototype":"prototype value","X-Preserved":"  value  "}',
  ) as unknown;

  const proxy = convertHappJson([specialNames]).proxies[0];
  assert.ok(proxy !== undefined);
  const wsOptions = proxy["ws-opts"] as { headers: Record<string, string> };
  assert.equal(Object.getPrototypeOf(wsOptions.headers), null);
  assert.deepEqual(Object.entries(wsOptions.headers), [
    ["__proto__", "proto value"],
    ["prototype", "prototype value"],
    ["X-Preserved", "  value  "],
  ]);
  assert.equal(Object.hasOwn(wsOptions.headers, "__proto__"), true);
});

test("rejects unknown keys in every consumed proxy layer", () => {
  const mutations: Array<(profile: Record<string, unknown>) => void> = [
    (profile) => {
      firstOutbound(profile).unknown = true;
    },
    (profile) => {
      (firstOutbound(profile).settings as Record<string, unknown>).unknown = true;
    },
    (profile) => {
      const vnext = (firstOutbound(profile).settings as Record<string, unknown>).vnext as Array<Record<string, unknown>>;
      (vnext[0] as Record<string, unknown>).unknown = true;
    },
    (profile) => {
      const stream = firstOutbound(profile).streamSettings as Record<string, unknown>;
      stream.unknown = true;
    },
    (profile) => {
      const stream = firstOutbound(profile).streamSettings as Record<string, unknown>;
      (stream.tlsSettings as Record<string, unknown>).unknown = true;
    },
  ];
  for (const mutate of mutations) {
    const profile = clone(vlessTcpTls());
    mutate(profile);
    assert.throws(() => convertHappJson([profile]), ConversionError);
  }
});

test("rejects transport ambiguity, duplicate ALPN, invalid sockopt, and Hysteria drift", () => {
  const ambiguous = clone(vlessTcpTls());
  (firstOutbound(ambiguous).streamSettings as Record<string, unknown>).wsSettings = {
    path: "/",
    headers: {},
  };

  const duplicateAlpn = clone(vlessTcpTls());
  const duplicateTls = (firstOutbound(duplicateAlpn).streamSettings as Record<string, unknown>)
    .tlsSettings as Record<string, unknown>;
  duplicateTls.alpn = ["h2", "h2"];

  const badSockopt = clone(vlessReality());
  const realityStream = firstOutbound(badSockopt).streamSettings as Record<string, unknown>;
  (realityStream.sockopt as Record<string, unknown>).tcpMaxSeg = 535;

  const drift = clone(hysteria());
  const hyStream = firstOutbound(drift).streamSettings as Record<string, unknown>;
  const quic = (hyStream.finalmask as Record<string, unknown>).quicParams as Record<string, unknown>;
  quic.keepAlivePeriod = 16;

  for (const profile of [ambiguous, duplicateAlpn, badSockopt, drift]) {
    assert.throws(() => convertHappJson([profile]), ConversionError);
  }
});

test("serializes only after the complete input validates", () => {
  const yaml = convertHappText(JSON.stringify([vlessTcpTls()]));
  const parsed = parse(yaml) as Record<string, unknown>;
  assert.deepEqual(parsed.rules, ["MATCH,Proxy"]);
  assert.throws(
    () => convertHappText(JSON.stringify([vlessTcpTls(), { remarks: "bad", outbounds: [] }])),
    ConversionError,
  );
  assert.throws(() => convertHappText("not json"), ConversionError);
});

test("rejects malformed UTF-8 bytes but accepts already-decoded string values", () => {
  assert.throws(
    () => convertHappText(malformedUtf8Subscription()),
    ConversionError,
  );
  assert.match(
    convertHappText(JSON.stringify([vlessTcpTls("Decoded \ufffd value")])),
    /Decoded \ufffd value/u,
  );
});
