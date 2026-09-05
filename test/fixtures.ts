export const vlessTcpTls = (remarks = "TLS node"): Record<string, unknown> => ({
  remarks,
  outbounds: [
    {
      protocol: "vless",
      tag: "proxy",
      settings: {
        vnext: [
          {
            address: "tls.example.test",
            port: 443,
            users: [
              {
                encryption: "none",
                flow: "",
                id: "00000000-0000-4000-8000-000000000001",
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: "tcp",
        security: "tls",
        tcpSettings: {},
        tlsSettings: {
          alpn: ["h2", "http/1.1"],
          fingerprint: "chrome",
          serverName: "sni.example.test",
        },
      },
    },
    { protocol: "freedom", settings: { ignored: true }, tag: "direct" },
  ],
});

export const vlessReality = (remarks = "Reality node"): Record<string, unknown> => ({
  remarks,
  outbounds: [
    {
      protocol: "vless",
      tag: "proxy",
      settings: {
        vnext: [
          {
            address: "reality.example.test",
            port: 8443,
            users: [
              {
                encryption: "none",
                flow: "xtls-rprx-vision",
                id: "00000000-0000-4000-8000-000000000002",
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        tcpSettings: {},
        realitySettings: {
          fingerprint: "firefox",
          publicKey: "r6onu6Y0J9A-kTXOc3d-f9Z4eJej-QUrMh8UmTfKvnE",
          serverName: "reality-sni.example.test",
          shortId: "0123456789abcdef",
          spiderX: "/ignored-but-validated",
        },
        sockopt: {
          tcpMaxSeg: 1_440,
          tcpNoDelay: true,
          tcpFastOpen: false,
          tcpcongestion: "bbr",
          tcpUserTimeout: 30_000,
          tcpKeepAliveIdle: 60,
          tcpKeepAliveInterval: 15,
        },
      },
    },
  ],
});

export const vlessWsTls = (remarks = "WS node"): Record<string, unknown> => ({
  remarks,
  outbounds: [
    {
      protocol: "vless",
      tag: "proxy",
      settings: {
        vnext: [
          {
            address: "ws.example.test",
            port: 443,
            users: [
              {
                encryption: "none",
                flow: "",
                id: "00000000-0000-4000-8000-000000000003",
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: "ws",
        security: "tls",
        wsSettings: {
          path: "/socket?ed=2048",
          headers: {
            Host: "front.example.test",
            "X-Synthetic": "  preserved value  ",
          },
        },
        tlsSettings: {
          alpn: ["http/1.1"],
          fingerprint: "safari",
          serverName: "ws-sni.example.test",
        },
      },
    },
  ],
});

export const hysteria = (remarks = "Hysteria node"): Record<string, unknown> => ({
  remarks,
  outbounds: [
    {
      protocol: "hysteria",
      tag: "proxy",
      settings: {
        address: "hy.example.test",
        port: 443,
        version: 2,
      },
      streamSettings: {
        network: "hysteria",
        security: "tls",
        hysteriaSettings: {
          auth: "  preserved password  ",
          version: 2,
        },
        tlsSettings: {
          alpn: ["h3"],
          fingerprint: "randomized",
          serverName: "hy-sni.example.test",
        },
        finalmask: {
          quicParams: {
            bbrProfile: "aggressive",
            congestion: "bbr",
            debug: false,
            initConnectionReceiveWindow: 8_388_608,
            initStreamReceiveWindow: 4_194_304,
            keepAlivePeriod: 15,
            maxConnectionReceiveWindow: 16_777_216,
            maxIdleTimeout: 30,
            maxIncomingStreams: 1_024,
            maxStreamReceiveWindow: 8_388_608,
          },
        },
      },
    },
  ],
});

export const aggregate = (): Record<string, unknown> => {
  const first = structuredClone(
    (vlessTcpTls().outbounds as Array<Record<string, unknown>>)[0],
  ) as Record<string, unknown>;
  first.tag = "proxy-one";
  const second = structuredClone(
    (vlessWsTls().outbounds as Array<Record<string, unknown>>)[0],
  ) as Record<string, unknown>;
  second.tag = "proxy-two";
  const third = structuredClone(
    (vlessReality().outbounds as Array<Record<string, unknown>>)[0],
  ) as Record<string, unknown>;
  third.tag = "proxy-three";
  return {
    remarks: "Ignored aggregate",
    dns: { any: "unconsumed" },
    inbounds: "unconsumed",
    meta: ["unconsumed"],
    observatory: {
      subjectSelector: ["proxy-"],
      probeInterval: "30s",
    },
    routing: {
      balancers: [
        {
          selector: ["proxy-"],
          strategy: { type: "leastPing" },
          tag: "automatic",
        },
      ],
      rules: [{ balancerTag: "automatic", type: "field" }],
      other: "unconsumed",
    },
    outbounds: [
      first,
      second,
      third,
      { protocol: "loopback", completely: "unconsumed", tag: "loop" },
    ],
  };
};

export const malformedUtf8Subscription = (): Uint8Array => {
  const marker = "Malformed UTF-8";
  const body = Buffer.from(JSON.stringify([vlessTcpTls(marker)]));
  const offset = body.indexOf(marker);
  if (offset < 0) throw new Error("malformed UTF-8 fixture marker is missing");
  body[offset] = 0x80;
  return body;
};

export const clone = <T>(value: T): T => structuredClone(value);
