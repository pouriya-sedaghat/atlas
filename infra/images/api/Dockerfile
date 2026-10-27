# syntax=docker/dockerfile:1
# Seyra Map Services API (Node 24 + Fastify 5). Built from the committed lockfile; the runtime
# image contains production dependencies only and never installs anything at start.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
# The preparation environment may re-terminate TLS; its CA is passed as an optional build secret
# (never stored in a layer). Operational hosts never run npm.
RUN --mount=type=secret,id=prep_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/prep_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/prep_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund -w packages/contracts -w apps/api --include-workspace-root=false
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build -w packages/contracts && npm run build -w apps/api \
    && npm prune --omit=dev -w packages/contracts -w apps/api --include-workspace-root=false

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /opt/seyra
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /src/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /src/apps/api/package.json ./apps/api/package.json
COPY --from=build /src/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/seyra/apps/api/dist/server.js"]
