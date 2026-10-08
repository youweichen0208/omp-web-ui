# syntax=docker/dockerfile:1
# pi-harness — multi-stage build. Builds the server (tsc) + frontend (vite),
# then runs a slim runtime image. `docker compose up -d` = one-command deploy
# with auto-restart on boot (`restart: unless-stopped`).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# node-pty falls back to node-gyp when no prebuilt binary matches — keep the
# toolchain around so `npm ci` works on any platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
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