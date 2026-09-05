# happ2mihomo

`happ2mihomo` is a local, Dockerized adapter that fetches a Happ JSON subscription and exposes a strict Mihomo YAML subscription for Clash Verge Rev.

The service supports VLESS TCP+Reality, VLESS TCP+TLS, VLESS WS+TLS, and Happ Hysteria version 2 profiles. A validated multi-outbound Happ aggregate is recognized and omitted from the generated proxy list. Compose publishes the service only on the host loopback interface.

## Choose one startup workflow

Requirements: Docker Engine with Compose v2 on Linux, or Docker Desktop on macOS.

Both alternatives begin in the repository directory. Create the private environment file:

```sh
(umask 077; cp .env.example .env)
```

Edit `.env` and replace the `REPLACE_ME` placeholder in `SUBSCRIPTION_URL` with the HTTPS Happ subscription URL. The placeholder is not a working configuration. The user agent defaults to `Happ/4.3.0/Android`. `HOST_PORT` is the local macOS or Linux port; it must be an unused integer from `1` through `65535`. Do not use `0`, because Compose would select an unpredictable host port. If `.env` already exists, run `chmod 600 .env` before editing it.

### Alternative A: Compose CLI

Build and start the service with the CLI. If you want the Docker Desktop Play-button workflow, skip these commands and use Alternative B instead.

```sh
docker compose up -d --build
docker compose ps
```

With the default `HOST_PORT=17890`, the local endpoints are:

```text
http://127.0.0.1:17890/sub
http://127.0.0.1:17890/healthz
```

For example, `HOST_PORT=18080` changes them to `http://127.0.0.1:18080/sub` and `http://127.0.0.1:18080/healthz`. The container port remains `17890`.

### Alternative B: Docker Desktop registration and Play button

This alternative registers the Compose application without first running `docker compose up`, so subsequent starts can use Docker Desktop's Play button. The macOS GUI labels may vary between Docker Desktop versions; this GUI flow has not been verified on macOS by the project.

1. Start Docker Desktop, clone or open this repository, and open a terminal in its root directory.
2. Create and edit `.env` as described above. Select the host port before registration, for example:

   ```dotenv
   HOST_PORT=17890
   ```

3. Build and create the application without starting it:

   ```sh
   docker compose create --build
   docker compose ps --all
   ```

   The service should be listed in the `created` state. Compose records the mapping `127.0.0.1:${HOST_PORT}:17890` at this point.

4. In Docker Desktop, open **Containers**, expand the `happ2mihomo` application, and press Play. Wait for the container to become healthy, then run the smoke checks below.

After changing `.env`, updating the source, or pulling a new version, recreate the stopped container before using Play again:

```sh
docker compose create --build --force-recreate
```

To rebuild, recreate, and start immediately instead:

```sh
docker compose up -d --build --force-recreate
```

## Smoke checks and lifecycle

The health endpoint is a liveness check for the local HTTP process. It does not fetch or validate the upstream subscription.

```sh
curl --fail --silent --show-error http://127.0.0.1:17890/healthz
```

The exact response body is:

```json
{"status":"ok"}
```

Verify that the provider can be fetched and converted without printing the generated proxy configuration:

```sh
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:17890/sub
```

Replace `17890` in both commands when `HOST_PORT` differs. Inspect status and logs with:

```sh
docker compose ps --all
docker compose logs --tail=100 happ2mihomo
```

Lifecycle commands have different effects:

```sh
docker compose stop     # stop but retain the Docker Desktop registration
docker compose start    # start the retained containers
docker compose down     # stop and remove the containers and registration
```

Troubleshooting:

- If startup reports that the port is already allocated, select another unused `HOST_PORT` in `.env` and recreate the container.
- Startup configuration errors are deliberately key-only. Under Compose, `Invalid configuration: SUBSCRIPTION_URL` or `Invalid configuration: HAPP_USER_AGENT` may appear repeatedly in logs because the restart policy retries the failed container; confirm that `SUBSCRIPTION_URL` no longer contains `REPLACE_ME`. `Invalid configuration: PORT` applies only when running Node.js directly or overriding the container environment, because Compose always pins `PORT=17890`.
- After an `.env` or image change, recreate the container; a plain restart retains the old container configuration. If the service remains `unhealthy`, call `/healthz`, inspect `docker compose logs`, then rebuild and recreate it.
- `502 Bad Gateway` means the provider response, redirect, or complete Happ payload was rejected, including conversion validation failures.
- `503 Service Unavailable` means the four-request concurrency limit was reached or the process is draining.
- `504 Gateway Timeout` means the upstream request exceeded 20 seconds.
- `404 Not Found` identifies an unknown route; `405 Method Not Allowed` identifies a method other than `GET`.
- `500 Internal Server Error` represents an unexpected local failure; inspect the container logs.

## Add the profile to Clash Verge Rev

1. Open the profile/subscription page in Clash Verge Rev.
2. Add or import a remote subscription URL and enter `http://127.0.0.1:17890/sub`, adjusted for your `HOST_PORT`.
3. Save or update the subscription, select the imported profile, and confirm that its proxies appear before enabling the system proxy or tunnel mode.

The exact control names can vary by release. See the official [Clash Verge Rev profile documentation](https://github.com/clash-verge-rev/clash-verge-rev.github.io/blob/main/docs/guide/profile.md) for the current UI and supported URL-import methods.

## Strict conversion behavior

The subscription is atomic and fail-closed. Every item must be either one supported standalone profile or one structurally recognized aggregate. An unsupported standalone profile, malformed proxy, malformed aggregate, dangling aggregate balancer selector/reference or fallback target, or unknown aggregate variant rejects the entire `/sub` response with `502 Bad Gateway`; invalid entries are never silently dropped. A feed containing only aggregates is also rejected because it would produce an empty Mihomo configuration.

A recognized aggregate has non-empty valid `remarks` and all of these properties:

- at least two strictly valid VLESS or Hysteria 2 proxy outbounds with unique, non-empty tags;
- one or more uniquely tagged routing balancers; every selector prefix matches at least one proxy, each balancer's selector list selects at least two proxies, and all balancers together cover every proxy;
- effective routing rules that reference every declared balancer and do not reference unknown balancers; an ordinary rule's `outboundTag` must be a non-empty identity string but need not name an aggregate outbound, and when both targets are present Xray gives `outboundTag` precedence and ignores `balancerTag`;
- only `random`, `roundRobin`, `leastPing`, or `leastLoad` strategies, with omitted strategy treated as `random`;
- exactly one valid `observatory` or `burstObservatory` for `leastPing` and `leastLoad`; partial subject selection is valid, `burstObservatory` requires an object `pingConfig`, and observation is optional for `random` and `roundRobin`;
- any `fallbackTag` points to a known outbound.

Harmless aggregate-level client sections that are not consumed by the converter are allowed only after the aggregate structure validates. Supported standalone profiles remain strictly validated at every consumed layer.

Operational limits are fixed: at most 4 active `/sub` requests, a 20-second upstream timeout, at most 3 HTTPS redirects, a 5 MiB decoded response-body limit, and at most 100,000 aggregate tag-prefix comparisons across the complete subscription/request. The 30-second response deadline is an event-loop timer: it aborts asynchronous work but cannot preempt synchronous JSON conversion. Conversion work is instead constrained by the 5 MiB input limit and the request-wide 100,000-comparison aggregate limit.

## Security behavior

- Compose publishes the service only on `127.0.0.1`; do not broaden the binding unless other hosts must reach it.
- `.env` is ignored by Git. Keep the subscription URL secret and do not paste it into logs, issues, fixtures, or committed files.
- Redirects remain HTTPS and may not contain credentials or fragments.
- Inbound client headers are never forwarded. Only the configured user agent, JSON accept header, and identity encoding request are application-supplied upstream.
- Errors and logs do not contain the upstream URL, response body, header values, redirect locations, or nested causes.
- The production container runs as UID/GID `1000:1000`, with a read-only root filesystem, a small temporary filesystem, and no-new-privileges.

## Development and tests

Node.js `24.20.0` is the supported local runtime. Install and execute verification in a disposable project copy when following the repository workflow; do not generate dependencies or build output in the shared working tree.

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

`PORT` controls the direct Node.js listener, defaults to `17890`, and accepts the exact decimal range `0` through `65535`. `PORT=0` requests an ephemeral port and is intended for tests. Compose pins the container listener to `17890`; Compose users should configure only `HOST_PORT`.

The tests use only synthetic endpoints, credentials, certificates, and payloads. A live compatibility test is opt-in; `npm run test:live` loads `SUBSCRIPTION_URL` and optional `HAPP_USER_AGENT` from `.env`. If the URL is absent from an ordinary `npm test` environment, the live test skips. The test neither saves nor reports the body, endpoints, hashes, or node counts:

```sh
npm run test:live
```

Validate generated YAML with checksum-pinned Mihomo `v1.19.30`:

```sh
npm run test:mihomo
```

The synthetic validation covers VLESS Reality, TCP TLS, and WS TLS with fingerprint `360`, plus Hysteria 2. Validate the provider subscription without saving or logging its contents with:

```sh
npm run test:mihomo:live
```

## License

This project is licensed under the [MIT License](LICENSE).
