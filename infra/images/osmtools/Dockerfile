# syntax=docker/dockerfile:1
# Seyra OSM tools image: osm2pgsql 2.3.1 and osmium-tool 1.19.1 built from pinned source
# (named build contexts osm2pgsql_src, osmium_tool_src). osmium-tool is compiled against the
# libosmium 2.23.1 / protozero 1.8.1 copies vendored by osm2pgsql 2.3.1. The versioned
# rendering catalog (flex Lua + post-import SQL) is baked in so the image identity pins it.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${UBUNTU_IMAGE} AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake g++ make pkgconf libboost-dev libboost-program-options-dev libexpat1-dev \
      libbz2-dev zlib1g-dev liblz4-dev libpq-dev libluajit-5.1-dev nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=osm2pgsql_src / /src/osm2pgsql
RUN cmake -S /src/osm2pgsql -B /build/osm2pgsql -DCMAKE_BUILD_TYPE=Release -DWITH_LUAJIT=ON \
      -DWITH_PROJ=OFF -DBUILD_TESTS=OFF \
    && cmake --build /build/osm2pgsql -j"$(nproc)" \
    && cmake --install /build/osm2pgsql
COPY --from=osmium_tool_src / /src/osmium-tool
RUN cmake -S /src/osmium-tool -B /build/osmium-tool -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
      -DOSMIUM_INCLUDE_DIR=/src/osm2pgsql/contrib/libosmium/include \
      -DPROTOZERO_INCLUDE_DIR=/src/osm2pgsql/contrib/protozero/include \
    && cmake --build /build/osmium-tool -j"$(nproc)" \
    && install -m 0755 /build/osmium-tool/src/osmium /usr/local/bin/osmium \
    && strip --strip-unneeded /usr/local/bin/osm2pgsql /usr/local/bin/osmium

FROM ${UBUNTU_IMAGE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libexpat1 libbz2-1.0 zlib1g liblz4-1 libpq5 libluajit-5.1-2 libboost-program-options1.83.0 \
      postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10002 osm \
    && useradd --system --uid 10002 --gid osm --home-dir /nonexistent --shell /usr/sbin/nologin osm
COPY --from=builder /usr/local/bin/osm2pgsql /usr/local/bin/osmium /usr/local/bin/
COPY --from=builder /usr/local/share/osm2pgsql /usr/local/share/osm2pgsql
COPY --from=osm2pgsql_src /COPYING /usr/share/doc/seyra/osm2pgsql-COPYING
COPY --from=osmium_tool_src /LICENSE.txt /usr/share/doc/seyra/osmium-tool-LICENSE.txt
COPY catalog/ /opt/seyra/catalog/
RUN osm2pgsql --version && osmium --version
USER osm
CMD ["osmium", "--version"]
