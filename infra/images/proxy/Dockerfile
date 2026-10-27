# syntax=docker/dockerfile:1
# Seyra proxy: Nginx TLS entry point + locally built web test client + map assets
# (SDF glyphs, font files, sprites). No CDN, no ACME, no remote includes.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG NGINX_IMAGE=nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/map-assets/package.json packages/map-assets/
COPY apps/web/package.json apps/web/
# The preparation environment may re-terminate TLS; its CA is passed as an optional build secret
# (never stored in a layer). Operational hosts never run npm.
RUN --mount=type=secret,id=prep_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/prep_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/prep_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund -w packages/contracts -w packages/map-assets -w apps/web --include-workspace-root=false
COPY packages/contracts packages/contracts
COPY packages/map-assets packages/map-assets
COPY apps/web apps/web
RUN npm run build -w packages/contracts && npm run build -w packages/map-assets \
    && node packages/map-assets/dist/build-assets.js /out/assets \
    && npm run build -w apps/web && cp -r apps/web/dist /out/web

FROM ${NGINX_IMAGE} AS runtime
RUN rm -rf /etc/nginx/conf.d /docker-entrypoint.d /docker-entrypoint.sh /usr/share/nginx/html \
    && mkdir -p /var/cache/seyra/tiles /tmp/nginx && chown -R nginx:nginx /var/cache/seyra /tmp/nginx
COPY --from=build /out/assets /usr/share/seyra/assets
COPY --from=build /out/web /usr/share/seyra/web
COPY infra/images/proxy/nginx.conf.template infra/images/proxy/locations.conf.template infra/images/proxy/security-headers.conf /etc/seyra/
COPY infra/images/proxy/entrypoint.sh /usr/local/bin/seyra-proxy-entrypoint
COPY infra/images/proxy/render.sh /usr/local/bin/seyra-proxy-render
RUN chmod 0755 /usr/local/bin/seyra-proxy-entrypoint /usr/local/bin/seyra-proxy-render
USER nginx
# 8443: ordinary listener (loopback control path or direct LAN mode); 8444: optional relay listener.
EXPOSE 8443 8444
ENTRYPOINT ["/usr/local/bin/seyra-proxy-entrypoint"]
