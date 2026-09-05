import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { parse } from "yaml";

import { readConfig } from "../dist/src/config.js";
import { convertHappText } from "../dist/src/converter.js";
import { fetchSubscription } from "../dist/src/upstream.js";
import {
  hysteria,
  vlessReality,
  vlessTcpTls,
  vlessWsTls,
} from "../dist/test/fixtures.js";

const VERSION = "1.19.30";
const assets = {
  x64: {
    name: `mihomo-linux-amd64-v${VERSION}.gz`,
    sha256: "cf06ce2c7d1421bdbda14ee4a5b6046672dc35ebf8eecd8e77504ec3c0ed9a84",
  },
  arm64: {
    name: `mihomo-linux-arm64-v${VERSION}.gz`,
    sha256: "58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069",
  },
};

if (process.platform !== "linux" || !(process.arch in assets)) {
  throw new Error("Mihomo validation supports Linux x64 and arm64 only");
}

const asset = assets[process.arch];
const download = await fetch(
  `https://github.com/MetaCubeX/mihomo/releases/download/v${VERSION}/${asset.name}`,
);
if (!download.ok) throw new Error("Mihomo download failed");
const archive = Buffer.from(await download.arrayBuffer());
const actualChecksum = createHash("sha256").update(archive).digest("hex");
if (actualChecksum !== asset.sha256) throw new Error("Mihomo checksum mismatch");

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--live")) {
  throw new Error("Usage: validate-mihomo.mjs [--live]");
}

let yaml;
if (args[0] === "--live") {
  const config = readConfig(process.env);
  const result = await fetchSubscription(
    config.subscriptionUrl,
    config.userAgent,
    new AbortController().signal,
  );
  yaml = convertHappText(result.body);
} else {
  const reality = vlessReality("Synthetic Reality");
  reality.outbounds[0].streamSettings.realitySettings.fingerprint = "360";
  const tcpTls = vlessTcpTls("Synthetic TCP TLS");
  tcpTls.outbounds[0].streamSettings.tlsSettings.fingerprint = "360";
  const wsTls = vlessWsTls("Synthetic WS TLS");
  wsTls.outbounds[0].streamSettings.tlsSettings.fingerprint = "360";
  yaml = convertHappText(
    JSON.stringify([
      reality,
      tcpTls,
      wsTls,
      hysteria("Synthetic Hysteria 2"),
    ]),
  );
  const parsed = parse(yaml);
  const fingerprints = parsed.proxies
    .filter((proxy) => proxy.type === "vless")
    .map((proxy) => proxy["client-fingerprint"]);
  if (
    fingerprints.length !== 3 ||
    fingerprints.some((fingerprint) => fingerprint !== "360")
  ) {
    throw new Error("Synthetic VLESS fingerprint coverage failed");
  }
}

const validationDirectory = mkdtempSync(join(tmpdir(), "happ2mihomo-mihomo-"));
try {
  const binaryPath = join(validationDirectory, "mihomo");
  writeFileSync(binaryPath, gunzipSync(archive), { mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'cat | "$1" -t -f /dev/stdin',
        "happ2mihomo-mihomo-pipe",
        binaryPath,
      ],
      {
        cwd: validationDirectory,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    let exitCode;
    let processFailed = false;
    let inputFailed = false;

    child.once("error", () => {
      processFailed = true;
    });
    child.once("exit", (code) => {
      exitCode = code;
    });
    child.once("close", () => {
      if (!processFailed && !inputFailed && exitCode === 0) {
        resolve();
      } else {
        reject(new Error("Mihomo rejected the generated configuration"));
      }
    });
    child.stdin.once("error", () => {
      inputFailed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    child.stdin.end(yaml);
  });
} finally {
  rmSync(validationDirectory, { recursive: true, force: true });
}
