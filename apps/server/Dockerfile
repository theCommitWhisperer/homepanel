# HomePanel server (+ kiosk web app). Build from the monorepo root:
#   docker build -f apps/server/Dockerfile -t homepanel .
#   docker run -p 8080:8080 -v homepanel-data:/data -e HA_URL=http://homeassistant.local:8123 -e HA_TOKEN=... homepanel
#   docker run -p 8080:8080 -e DEMO=1 homepanel          # demo, no HA/MQTT needed

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/ai/package.json packages/ai/
COPY apps/server/package.json apps/server/
COPY apps/kiosk/package.json apps/kiosk/
RUN pnpm install --frozen-lockfile --filter @homepanel/server... --filter @homepanel/kiosk...
COPY packages/protocol packages/protocol
COPY packages/ai packages/ai
COPY apps/server apps/server
COPY apps/kiosk apps/kiosk
RUN pnpm --filter @homepanel/protocol build \
 && pnpm --filter @homepanel/ai build \
 && pnpm --filter @homepanel/kiosk build \
 && pnpm --filter @homepanel/server build \
 && pnpm --filter @homepanel/server deploy --prod --legacy /out \
 && cp -r apps/kiosk/dist /out/kiosk-dist

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    KIOSK_DIST=/app/kiosk-dist
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8080
# no USER switch: the HA app (add-on) runtime mounts /data as root; set `--user node` for plain Docker if you like
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
