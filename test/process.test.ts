import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const collect = (child: ChildProcess): { stderr: string[]; stdout: string[] } => {
  const output = { stderr: [] as string[], stdout: [] as string[] };
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => output.stderr.push(chunk));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => output.stdout.push(chunk));
  return output;
};

const waitForOutput = (
  child: ChildProcess,
  output: { stderr: string[]; stdout: string[] },
  expected: string,
  timeoutMs = 5_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const diagnostics = (): string =>
      `stdout=${JSON.stringify(output.stdout.join(""))} stderr=${JSON.stringify(output.stderr.join(""))}`;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", inspect);
      child.off("error", onError);
      child.off("close", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const inspect = (): void => {
      if (output.stdout.join("").includes(expected)) finish();
    };
    const onError = (error: Error): void => {
      finish(new Error(`child failed before startup: ${error.message}; ${diagnostics()}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(
          `child exited before startup: code=${String(code)} signal=${String(signal)}; ${diagnostics()}`,
        ),
      );
    };
    const timeout = setTimeout(() => {
      finish(new Error(`startup timed out; ${diagnostics()}`));
    }, timeoutMs);

    child.stdout?.on("data", inspect);
    child.once("error", onError);
    child.once("close", onExit);
    inspect();
  });

test("startup wait reports early exit with captured stderr", async () => {
  const child = spawn(
    process.execPath,
    ["--eval", "console.error('synthetic startup failure'); process.exit(7)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = collect(child);
  await assert.rejects(
    waitForOutput(child, output, "never emitted"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code=7/u);
      assert.match(error.message, /synthetic startup failure/u);
      return true;
    },
  );
});

test("startup wait reports a timeout with captured output", async () => {
  const child = spawn(
    process.execPath,
    ["--eval", "console.error('still starting'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = collect(child);
  try {
    await assert.rejects(
      waitForOutput(child, output, "never emitted", 250),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /startup timed out/u);
        assert.match(error.message, /still starting/u);
        return true;
      },
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

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

test("invalid PORT exits 1 with a key-only error", async () => {
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: {
      ...process.env,
      SUBSCRIPTION_URL: "https://example.test/sub",
      PORT: " 17890",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const [code] = (await once(child, "exit")) as [number, NodeJS.Signals | null];
  assert.equal(code, 1);
  assert.equal(output.stdout.join(""), "");
  assert.equal(output.stderr.join(""), "Invalid configuration: PORT\n");
});

test("occupied PORT exits 1 with a static server error", async () => {
  const blocker = createServer();
  blocker.listen(0, "0.0.0.0");
  await once(blocker, "listening");
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: {
      ...process.env,
      SUBSCRIPTION_URL: "https://example.test/sub",
      PORT: String(address.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  try {
    const [code] = (await once(child, "close")) as [
      number,
      NodeJS.Signals | null,
    ];
    assert.equal(code, 1);
    assert.equal(output.stdout.join(""), "");
    assert.equal(output.stderr.join(""), "Server failed\n");
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});

test("SIGTERM performs a normal drain and exits 0 without logging the URL", async () => {
  const secret = "synthetic-secret-marker";
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    env: {
      ...process.env,
      SUBSCRIPTION_URL: `https://example.test/sub?token=${secret}`,
      HAPP_USER_AGENT: "Synthetic-UA",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  try {
    await waitForOutput(child, output, "happ2mihomo listening");
    const match = /happ2mihomo listening on 0\.0\.0\.0:([1-9]\d*)/u.exec(
      output.stdout.join(""),
    );
    assert.ok(match !== null);
    const health = await fetch(`http://127.0.0.1:${match[1]}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"status":"ok"}\n');
    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number, NodeJS.Signals | null];
    assert.equal(code, 0);
    assert.equal(output.stderr.join(""), "");
    assert.equal(`${output.stdout.join("")}\n${output.stderr.join("")}`.includes(secret), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
