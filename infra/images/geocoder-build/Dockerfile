# syntax=docker/dockerfile:1
# Seyra geocoder BUILD image (never a runtime service): ephemeral PostgreSQL 16 + PostGIS,
# Nominatim 5.3.2 (hash-pinned wheel; Python dependencies from Ubuntu packages) and the
# Photon 1.3.0 CLI used for the JSON export. osm2pgsql/osmium come from the Seyra osmtools image.
ARG PHOTON_IMAGE=seyra-demo/photon:1.3.0-seyra1
ARG OSMTOOLS_IMAGE=seyra-demo/osmtools:2.3.1-1.19.1-seyra1
FROM ${OSMTOOLS_IMAGE} AS osmtools

FROM ${PHOTON_IMAGE}
ARG NOMINATIM_WHEEL_SHA256=c5e1c4bd27f52a48843a5fe204a1a7b5f4d4d2911880e65721b4c900b13227e5
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-16 postgresql-16-postgis-3 python3-icu python3-psycopg python3-jinja2 python3-yaml \
      python3-dotenv python3-psutil python3-mwparserfromhell python3-venv \
      libpq5 libexpat1 libbz2-1.0 liblz4-1 libluajit-5.1-2 libboost-program-options1.83.0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=osmtools /usr/local/bin/osm2pgsql /usr/local/bin/osmium /usr/local/bin/
COPY --from=osmtools /usr/local/share/osm2pgsql /usr/local/share/osm2pgsql
COPY --from=nominatim_artifacts /nominatim_db-5.3.2-py3-none-any.whl /tmp/
RUN echo "${NOMINATIM_WHEEL_SHA256}  /tmp/nominatim_db-5.3.2-py3-none-any.whl" | sha256sum -c - \
    && python3 -m venv --system-site-packages /opt/nominatim \
    && /opt/nominatim/bin/pip install --no-index --no-deps --no-cache-dir /tmp/nominatim_db-5.3.2-py3-none-any.whl \
    && rm /tmp/nominatim_db-5.3.2-py3-none-any.whl \
    && /opt/nominatim/bin/nominatim --version
COPY geocoder-build.sh /usr/local/bin/seyra-geocoder-build
RUN chmod 0755 /usr/local/bin/seyra-geocoder-build
USER postgres
ENTRYPOINT ["/usr/local/bin/seyra-geocoder-build"]
