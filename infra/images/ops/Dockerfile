# syntax=docker/dockerfile:1
# Seyra ops image: the seyra-maps release CLI (Node 24) plus static Docker CLI/Compose
# binaries. It drives local images through the host Docker socket; it never pulls or builds.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG DOCKER_CLI_IMAGE=docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${NODE_IMAGE} AS nodebin

FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/map-assets/package.json packages/map-assets/
COPY apps/ops/package.json apps/ops/
# The preparation environment may re-terminate TLS; its CA is passed as an optional build secret
# (never stored in a layer). Operational hosts never run npm.
RUN --mount=type=secret,id=prep_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/prep_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/prep_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund -w packages/contracts -w packages/map-assets -w apps/ops --include-workspace-root=false
COPY packages/contracts packages/contracts
COPY packages/map-assets packages/map-assets
COPY apps/ops apps/ops
RUN npm run build -w packages/contracts && npm run build -w packages/map-assets && npm run build -w apps/ops \
    && npm prune --omit=dev -w packages/contracts -w packages/map-assets -w apps/ops --include-workspace-root=false

FROM ${UBUNTU_IMAGE} AS runtime
# Ubuntu base for the openssl CLI (local TLS material generation); Node 24 binary copied from
# the pinned official Node image; static Docker CLI + Compose plugin from the pinned docker:cli.
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /opt/seyra
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /src/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /src/packages/map-assets/package.json ./packages/map-assets/package.json
COPY --from=build /src/packages/map-assets/dist ./packages/map-assets/dist
COPY --from=build /src/apps/ops/package.json ./apps/ops/package.json
COPY --from=build /src/apps/ops/dist ./apps/ops/dist
# Install files (compose, catalog, Valhalla config, dependency lock, migrations) are NOT baked in:
# they are mounted read-only from the verified bundle at /opt/seyra-install (avoids a circular
# identity between this image and the lock that records it).
ENV SEYRA_INSTALL_DIR=/opt/seyra-install
# flock (util-linux, part of the pinned Ubuntu base) provides the lifecycle lock (kernel flock(2)).
RUN docker --version && docker compose version && flock --version
ENTRYPOINT ["node", "/opt/seyra/apps/ops/dist/main.js"]
