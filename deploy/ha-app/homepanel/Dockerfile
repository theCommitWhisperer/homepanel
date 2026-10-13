# HomePanel as a Home Assistant app (add-on).
#
# Home Assistant builds apps with THIS folder as the build context, so it can't see the monorepo.
# This Dockerfile therefore fetches the source with git (HOMEPANEL_GIT / HOMEPANEL_REF in build.yaml)
# and builds it on the device. That takes a few minutes on an N100 and much longer on a Raspberry Pi.
#
# Faster alternative for releases: build per-arch images in CI, e.g.
#   docker buildx build --platform linux/amd64 \
#     --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21 --build-arg HOMEPANEL_REF=v0.1.0 \
#     -t ghcr.io/<you>/homepanel-amd64:0.1.0 deploy/ha-app/homepanel
# push them, and add `image: ghcr.io/<you>/homepanel-{arch}` to config.yaml so HA pulls instead of builds.
# For local testing you can also copy a monorepo checkout into this folder as ./src-local/; it is used
# instead of cloning.
ARG BUILD_FROM
FROM ${BUILD_FROM} AS build
ARG HOMEPANEL_GIT=https://github.com/theCommitWhisperer/homepanel
ARG HOMEPANEL_REF=main
RUN apk add --no-cache nodejs npm git \
 && npm install -g pnpm@10
WORKDIR /src
# Use ./src-local (a checkout copied next to this Dockerfile) if present; otherwise clone.
COPY . /ctx
RUN if [ -f /ctx/src-local/pnpm-workspace.yaml ]; then cp -a /ctx/src-local/. /src/; \
    else git clone --depth 1 --branch "${HOMEPANEL_REF}" "${HOMEPANEL_GIT}" /src; fi \
 && rm -rf /ctx
RUN pnpm install --frozen-lockfile --filter @homepanel/server... --filter @homepanel/kiosk... \
 && pnpm --filter @homepanel/protocol build \
 && pnpm --filter @homepanel/ai build \
 && pnpm --filter @homepanel/kiosk build \
 && pnpm --filter @homepanel/server build \
 && pnpm --filter @homepanel/server deploy --prod --legacy /out \
 && cp -r apps/kiosk/dist /out/kiosk-dist

FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
ENV NODE_ENV=production PORT=8080 KIOSK_DIST=/app/kiosk-dist
WORKDIR /app
COPY --from=build /out /app
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD ["/run.sh"]
