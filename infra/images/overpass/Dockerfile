# syntax=docker/dockerfile:1
# Seyra Overpass image: Overpass API osm3s_v0.7.62.4 built from pinned source (named build
# context overpass_src). Only the interpreter/status CGI endpoints are exposed through an
# in-container nginx + fcgiwrap on a private port. No clone/replication/area scripts are used;
# the base database is created by the explicit build job (osmium XML -> update_database).
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${UBUNTU_IMAGE} AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ make autoconf automake libtool autoconf-archive expat libexpat1-dev zlib1g-dev \
      liblz4-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=overpass_src /src /src/overpass/src
WORKDIR /src/overpass/src
RUN autoscan && aclocal && autoheader && libtoolize && automake --add-missing && autoconf
WORKDIR /build
RUN /src/overpass/src/configure CXXFLAGS="-O2" --prefix=/opt/overpass --enable-lz4 \
    && make -j"$(nproc)" install \
    && strip --strip-unneeded /opt/overpass/bin/* /opt/overpass/cgi-bin/interpreter /opt/overpass/cgi-bin/status 2>/dev/null; \
    test -x /opt/overpass/bin/dispatcher && test -x /opt/overpass/bin/update_database \
    && test -x /opt/overpass/cgi-bin/interpreter

FROM ${UBUNTU_IMAGE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libexpat1 zlib1g liblz4-1 libstdc++6 nginx-light fcgiwrap \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/* \
    && groupadd --system --gid 10004 overpass \
    && useradd --system --uid 10004 --gid overpass --home-dir /nonexistent --shell /usr/sbin/nologin overpass
# Only the programs Seyra uses; upstream clone/replication/area helper scripts are not shipped.
COPY --from=builder /opt/overpass/bin/dispatcher /opt/overpass/bin/update_database /opt/overpass/bin/osm3s_query /opt/overpass/bin/
COPY --from=builder /opt/overpass/cgi-bin/interpreter /opt/overpass/cgi-bin/status /opt/overpass/cgi-bin/
COPY --from=overpass_src /COPYING /usr/share/doc/seyra/overpass-COPYING
COPY nginx.conf /etc/seyra/overpass-nginx.conf
COPY entrypoint.sh /usr/local/bin/seyra-overpass
RUN chmod 0755 /usr/local/bin/seyra-overpass
USER overpass
ENV PATH=/opt/overpass/bin:$PATH
ENTRYPOINT ["/usr/local/bin/seyra-overpass"]
CMD ["serve"]
