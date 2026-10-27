# syntax=docker/dockerfile:1
# Seyra Valhalla image: built from pinned upstream source supplied as named build contexts
# (valhalla_src = valhalla 3.9.1, prime_server_src = prime_server 0.12.0). No scripted
# entrypoint, no tile download, no PBF watching: graph builds and serving are explicit commands.
# HTTP (libcurl) support is compiled out so the binaries cannot fetch remote tiles.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${UBUNTU_IMAGE} AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake g++ gcc make pkgconf git ca-certificates \
      libboost-all-dev libczmq-dev libzmq3-dev libcurl4-openssl-dev \
      libgeos++-dev libgeos-dev libluajit-5.1-dev luajit liblz4-dev \
      libprotobuf-dev protobuf-compiler libspatialite-dev libsqlite3-dev \
      libsqlite3-mod-spatialite spatialite-bin libssl-dev libexpat1-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=prime_server_src / /src/prime_server
RUN cmake -S /src/prime_server -B /build/prime_server -DCMAKE_BUILD_TYPE=Release -DENABLE_WERROR=OFF \
    && cmake --build /build/prime_server -j"$(nproc)" \
    && cmake --install /build/prime_server
COPY --from=valhalla_src / /src/valhalla
RUN cmake -S /src/valhalla -B /build/valhalla -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_TESTS=OFF -DENABLE_PYTHON_BINDINGS=OFF -DENABLE_CCACHE=OFF -DENABLE_HTTP=OFF \
      -DENABLE_GEOTIFF=OFF -DENABLE_SINGLE_FILES_WERROR=OFF -DENABLE_SERVICES=ON \
      -DENABLE_DATA_TOOLS=ON -DENABLE_TOOLS=ON \
    && cmake --build /build/valhalla -j"$(nproc)" \
    && cmake --install /build/valhalla
# spatialite-bin is only a configure-time requirement of the upstream CMake (timezone script);
# that download script is never run. Strip is best effort for script files in the glob.
RUN for f in /usr/local/bin/valhalla_*; do strip --strip-unneeded "$f" 2>/dev/null || true; done

FROM ${UBUNTU_IMAGE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libczmq4 libzmq5 libluajit-5.1-2 libprotobuf-lite32t64 libprotobuf32t64 libsqlite3-0 \
      libsqlite3-mod-spatialite libspatialite8t64 libgeos-c1t64 liblz4-1 zlib1g libexpat1 \
      libboost-program-options1.83.0 libssl3t64 libcurl4t64 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 valhalla \
    && useradd --system --uid 10001 --gid valhalla --home-dir /nonexistent --shell /usr/sbin/nologin valhalla
COPY --from=builder /usr/local/bin/ /usr/local/bin/
COPY --from=builder /usr/local/lib/ /usr/local/lib/
COPY --from=valhalla_src /LICENSE.md /usr/share/doc/seyra/valhalla-LICENSE.md
COPY --from=prime_server_src /COPYING /usr/share/doc/seyra/prime_server-COPYING
# libcurl is linked by prime_server; Valhalla's own remote tile fetching is compiled out
# (ENABLE_HTTP=OFF) and no curl/wget CLI is installed. Upstream helper scripts that download (or, like valhalla_build_extract --region, can download)
# timezone/elevation data or need Python are removed from the runtime image.
RUN rm -f /usr/local/bin/valhalla_build_timezones /usr/local/bin/valhalla_build_elevation /usr/local/bin/valhalla_build_config /usr/local/bin/valhalla_build_extract
RUN ldconfig && for b in valhalla_service valhalla_build_tiles valhalla_build_admins; do \
      command -v "$b" >/dev/null || { echo "missing $b"; exit 1; }; done
USER valhalla
# No ENTRYPOINT: runtime compose and build jobs pass explicit commands.
CMD ["valhalla_service", "--help"]
