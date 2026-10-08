# syntax=docker/dockerfile:1
# pi-harness — multi-stage build. Builds the server (tsc) + frontend (vite),
# then runs a slim runtime image. `docker compose up -d` = one-command deploy
# with auto-restart on boot (`restart: unless-stopped`).
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Both dependency installs need node-gyp on Linux (node-pty has no Linux
# prebuild). git is also required by the runtime's SCM and native tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
COPY scripts/check-lockfile.mjs ./scripts/check-lockfile.mjs
RUN npm run check:lockfile && npm ci
COPY . .
RUN npm run build

FROM base
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts/check-lockfile.mjs ./scripts/check-lockfile.mjs
RUN npm run check:lockfile && npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
ENV PORT=8787
# Everything that must survive a rebuild lives under /data: pi config, auth and
# chat sessions (PI_CODING_AGENT_DIR) and pi-harness state, uploads and Wiki
# history (PI_WEB_DATA_DIR). Without these the server would write to the
# node user's home, which is not a volume.
ENV PI_CODING_AGENT_DIR=/data/pi-agent \
    PI_WEB_DATA_DIR=/data/pi-harness \
    PI_WEB_CWD=/workspace
RUN mkdir -p /data/pi-agent /data/pi-harness /workspace \
    && chown -R node:node /data /workspace
EXPOSE 8787
VOLUME ["/data"]
USER node
CMD ["node", "dist/server/index.js"]
