# syntax=docker/dockerfile:1
# Seyra Tegola image: tegola v0.21.2 built from pinned source (named build context tegola_src)
# using its vendored Go modules (-mod=vendor, no module download). The built-in viewer, cloud
# cache back ends, GeoPackage provider and Prometheus observer are compiled out.
ARG GO_IMAGE=golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${GO_IMAGE} AS builder
ARG TEGOLA_VERSION=v0.21.2
ARG TEGOLA_REVISION=unknown
ENV CGO_ENABLED=0 GOFLAGS=-mod=vendor GOTOOLCHAIN=local GOPROXY=off
COPY --from=tegola_src / /src/tegola
WORKDIR /src/tegola/cmd/tegola
RUN go build -trimpath \
      -tags 'noViewer noAzblobCache noS3Cache noRedisCache noGCSCache noGpkgProvider noPrometheusObserver' \
      -ldflags "-s -w -X 'github.com/go-spatial/tegola/internal/build.Version=${TEGOLA_VERSION}' -X 'github.com/go-spatial/tegola/internal/build.GitRevision=${TEGOLA_REVISION}' -X 'github.com/go-spatial/tegola/internal/build.GitBranch=${TEGOLA_VERSION}'" \
      -o /out/tegola . \
    && /out/tegola version

FROM ${UBUNTU_IMAGE} AS runtime
RUN groupadd --system --gid 10003 tegola \
    && useradd --system --uid 10003 --gid tegola --home-dir /nonexistent --shell /usr/sbin/nologin tegola
COPY --from=builder /out/tegola /usr/local/bin/tegola
COPY --from=tegola_src /LICENSE.md /usr/share/doc/seyra/tegola-LICENSE.md
COPY serve.sh /usr/local/bin/seyra-tegola-serve
RUN chmod 0755 /usr/local/bin/seyra-tegola-serve
USER tegola
ENTRYPOINT ["/usr/local/bin/seyra-tegola-serve"]
