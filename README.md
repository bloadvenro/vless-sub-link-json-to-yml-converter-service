# happ2mihomo

`happ2mihomo` is a local, Dockerized adapter that fetches a Happ JSON subscription and exposes a strict Mihomo YAML subscription for Clash Verge Rev.

The service listens only through a Compose loopback binding. The default URL is `http://127.0.0.1:17890`, and the host port can be changed with `HOST_PORT` in `.env`. It supports VLESS TCP+Reality, VLESS TCP+TLS, VLESS WS+TLS, and Happ Hysteria version 2 profiles. Recognized multi-outbound Happ aggregate profiles are excluded from the generated proxy list.

## Run with Docker Compose

Requirements: Docker Engine with Compose v2 on Linux, or Docker Desktop on macOS.

```sh
(umask 077; cp .env.example .env)
```

Edit `.env` and replace the placeholder with the HTTPS subscription URL. The optional user agent defaults to `Happ/4.3.0/Android`. `HOST_PORT` is the port exposed on macOS or Linux and defaults to `17890`. If `.env` already exists, run `chmod 600 .env` before editing it.

```sh
docker compose up -d --build
docker compose ps
```

With the default `HOST_PORT=17890`, use this remote profile URL in Clash Verge Rev:

```text
http://127.0.0.1:17890/sub
```

If you select another `HOST_PORT`, replace `17890` in that URL with your value. The local health endpoint follows the same rule; by default it is `http://127.0.0.1:17890/healthz`.

## Docker Desktop one-time registration

Docker Desktop cannot create a local Compose application from `compose.yaml` with only a GUI click. Register and build the stable `happ2mihomo` Compose application once from a terminal:

The port is set before registration in `.env`:

```dotenv
HOST_PORT=17890
```

Compose uses this value in the mapping `127.0.0.1:${HOST_PORT}:17890`: the first port is the port available on macOS, while the final `17890` is the fixed port inside the container. For example, `HOST_PORT=18080` makes the subscription URL `http://127.0.0.1:18080/sub`. The binding remains local to the computer.

```sh
docker compose create --build
```

The command reads `.env`, creates the port mapping, and registers the application. It then appears under **Containers** as `happ2mihomo`. Docker Desktop's Play button starts the already-created application after that initial registration.

After changing `.env`, updating source, or pulling a new version, rebuild and recreate the container:

```sh
docker compose create --build --force-recreate
```

The Docker Desktop Play button can start the recreated container. Alternatively, perform the update and start in one command:

```sh
docker compose up -d --build --force-recreate
```

## Security behavior

- Compose publishes the service only on `127.0.0.1`; do not broaden the binding unless other hosts must reach it.
- `.env` is ignored by Git. Keep the subscription URL secret and do not paste it into logs, issues, fixtures, or committed files.
- Redirects remain HTTPS and may not contain credentials or fragments. Response bodies are capped at 5 MiB after decoding.
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

The tests use only synthetic endpoints, credentials, certificates, and payloads. A live compatibility test is opt-in; `npm run test:live` loads `SUBSCRIPTION_URL` and the optional `HAPP_USER_AGENT` from `.env`. When the URL is absent from an ordinary `npm test` environment, the live test skips. The test neither saves nor reports the body, endpoints, hashes, or node counts:

```sh
npm run test:live
```

Validate generated YAML with Mihomo `v1.19.30` in a Docker build target:

```sh
npm run test:mihomo
```

The helper selects the official Linux amd64 or arm64 archive, verifies the pinned SHA-256 checksum, generates one synthetic config containing all four supported proxy shapes, pipes it to Mihomo over standard input, and requires `mihomo -t -f` to exit successfully.

Validate the provider subscription from `.env` with the reusable Docker runner:

```sh
npm run test:mihomo:live
```

This builds the runner without subscription data, passes `.env` only to the runtime container, downloads the checksum-pinned Mihomo binary into a temporary directory, and pipes the converted YAML over standard input. Provider YAML is not saved or logged.

To stop and remove the local application:

```sh
docker compose down
```
