# HomePanel as a Home Assistant app (add-on).
#
# Home Assistant builds apps with THIS folder as the build context, so it can't see the monorepo.
# This Dockerfile therefore fetches the source with git (HOMEPANEL_GIT / HOMEPANEL_REF: a branch, tag
# or commit SHA) and builds it on the device. That takes a few minutes on an N100 and much longer on a
# Raspberry Pi.
#
# Since Supervisor 2026.04 the base image is no longer passed in (build.yaml is retired), so the default
# below is what HA uses: the multi-arch base image. Override for testing, e.g.
#   docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21 \
#     --build-arg HOMEPANEL_REF=<sha> -t homepanel-app deploy/ha-app/homepanel
# For local testing you can also copy a monorepo checkout into this folder as ./src-local/; it is used
# instead of cloning. CI builds this on every push (.github/workflows/release.yml, job ha-app).
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23
FROM ${BUILD_FROM} AS build
ARG HOMEPANEL_GIT=https://github.com/theCommitWhisperer/homepanel
ARG HOMEPANEL_REF=main
# pnpm version of the repo's packageManager field (the lockfile format must match)
ARG PNPM_VERSION=10.28.0
RUN apk add --no-cache nodejs npm git \
 && node -e "const v=+process.versions.node.split('.')[0]; if (v < 22) { console.error('HomePanel needs Node 22+, this base image has ' + process.version); process.exit(1) }" \
 && npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /src
# Use ./src-local (a checkout copied next to this Dockerfile) if present; otherwise fetch HOMEPANEL_REF.
# (git fetch by name works for branches, tags and full commit SHAs; `clone --branch` can't take a SHA.)
COPY . /ctx
RUN if [ -f /ctx/src-local/pnpm-workspace.yaml ]; then cp -a /ctx/src-local/. /src/; \
    else git init -q /src \
      && git -C /src remote add origin "${HOMEPANEL_GIT}" \
      && git -C /src fetch -q --depth 1 origin "${HOMEPANEL_REF}" \
      && git -C /src checkout -q FETCH_HEAD; fi \
 && rm -rf /ctx /src/.git
# server + kiosk (screens, /admin) + the PC agent's Windows files (served at /agent/install.ps1)
RUN pnpm install --frozen-lockfile --filter @homepanel/server... --filter @homepanel/kiosk... --filter @homepanel/agent... \
 && pnpm --filter @homepanel/protocol build \
 && pnpm --filter @homepanel/ai build \
 && pnpm --filter @homepanel/kiosk build \
 && pnpm --filter @homepanel/agent build \
 && pnpm --filter @homepanel/server build \
 && pnpm --filter @homepanel/server deploy --prod --legacy /out \
 && cp -r apps/kiosk/dist /out/kiosk-dist \
 && cp -r apps/agent/dist/windows /out/agent-dist \
 && test -f /out/dist/index.js && test -f /out/node_modules/@homepanel/protocol/dist/index.js && test -f /out/agent-dist/install.ps1

FROM ${BUILD_FROM}
ARG BUILD_VERSION=0.2.1
ARG BUILD_ARCH=amd64
RUN apk add --no-cache nodejs
ENV NODE_ENV=production PORT=8080 KIOSK_DIST=/app/kiosk-dist AGENT_DIST=/app/agent-dist
WORKDIR /app
COPY --from=build /out /app
COPY run.sh /run.sh
RUN chmod a+x /run.sh
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="HomePanel" \
    org.opencontainers.image.description="Dashboard server for wall tablets and screens" \
    org.opencontainers.image.source="https://github.com/theCommitWhisperer/homepanel"
CMD ["/run.sh"]
