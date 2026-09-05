# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build
RUN npm prune --omit=dev

FROM build AS mihomo-runner
COPY scripts ./scripts
ENTRYPOINT ["node", "scripts/validate-mihomo.mjs"]

FROM mihomo-runner AS mihomo-test
RUN npm run test:mihomo:local

FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist/src ./dist/src
USER 1000:1000
EXPOSE 17890
CMD ["node", "dist/src/index.js"]
