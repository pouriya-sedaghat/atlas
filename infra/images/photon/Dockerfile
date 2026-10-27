# syntax=docker/dockerfile:1
# Seyra Photon runtime: official photon-1.3.0.jar (built from the tree of tag 1.3.0) on the
# Ubuntu OpenJDK 21 runtime. Embedded OpenSearch only; no update API is enabled.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
FROM ${UBUNTU_IMAGE}
ARG PHOTON_JAR_SHA256=a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10005 photon \
    && useradd --system --uid 10005 --gid photon --home-dir /nonexistent --shell /usr/sbin/nologin photon
COPY --from=photon_artifacts /photon-1.3.0.jar /opt/photon/photon.jar
RUN echo "${PHOTON_JAR_SHA256}  /opt/photon/photon.jar" | sha256sum -c -
COPY --from=photon_src /LICENSE /usr/share/doc/seyra/photon-LICENSE
COPY serve.sh /usr/local/bin/seyra-photon-serve
RUN chmod 0755 /usr/local/bin/seyra-photon-serve
USER photon
ENTRYPOINT ["/usr/local/bin/seyra-photon-serve"]
