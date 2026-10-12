# HomePanel server + kiosk web app in one small image.
#
# Build from the MONOREPO ROOT (the build context must be the whole repo):
#   docker build -f deploy/docker/Dockerfile -t homepanel .
# Run:
#   docker run -d --name homepanel -p 8080:8080 -v homepanel-data:/data \
#     -e HA_URL=http://homeassistant.local:8123 -e HA_TOKEN=<long-lived token> \
#     -e MQTT_URL=mqtt://<broker>:1883 -e MQTT_USER=homepanel -e MQTT_PASS=<pw> \
#     -e ADMIN_PASSWORD=<pw> homepanel
#   docker run --rm -p 8080:8080 -e DEMO=1 homepanel      # demo: no HA or MQTT needed
#
# deploy/docker/Dockerfile.dockerignore keeps node_modules, dist and data out of the context.

# ---- build stage: install the workspace and build protocol → ai → kiosk → server -------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# manifests first so dependency installs are cached between source edits
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/ai/package.json packages/ai/
COPY apps/server/package.json apps/server/
COPY apps/kiosk/package.json apps/kiosk/
RUN pnpm install --frozen-lockfile --filter "@homepanel/server..." --filter "@homepanel/kiosk..."
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

# ---- runtime stage: node + the deployed server package only ---------------------------------
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
