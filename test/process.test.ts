import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

const collect = (child: ChildProcess): { stderr: string[]; stdout: string[] } => {
  const output = { stderr: [] as string[], stdout: [] as string[] };
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => output.stderr.push(chunk));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => output.stdout.push(chunk));
  return output;
};

const waitForOutput = async (chunks: string[], expected: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (chunks.join("").includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`missing expected static output: ${expected}`);
};

test("invalid startup configuration exits 1 with a key-only error", async () => {
  const secret = "synthetic-secret-marker";
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: {
      ...process.env,
      SUBSCRIPTION_URL: `http://user:${secret}@example.test/sub#fragment`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const [code] = (await once(child, "exit")) as [number, NodeJS.Signals | null];
  assert.equal(code, 1);
  assert.equal(output.stdout.join(""), "");
  assert.equal(output.stderr.join(""), "Invalid configuration: SUBSCRIPTION_URL\n");
  assert.equal(output.stderr.join("").includes(secret), false);
});

test("SIGTERM performs a normal drain and exits 0 without logging the URL", async () => {
  const secret = "synthetic-secret-marker";
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: {
      ...process.env,
      SUBSCRIPTION_URL: `https://example.test/sub?token=${secret}`,
      HAPP_USER_AGENT: "Synthetic-UA",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  try {
    await waitForOutput(output.stdout, "happ2mihomo listening");
    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number, NodeJS.Signals | null];
    assert.equal(code, 0);
    assert.equal(output.stderr.join(""), "");
    assert.equal(`${output.stdout.join("")}\n${output.stderr.join("")}`.includes(secret), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
