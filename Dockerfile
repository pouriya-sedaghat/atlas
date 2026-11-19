FROM docker.io/library/python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=atlas_site.settings

RUN groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin atlas \
    && groupadd --gid 10002 atlas-verifier \
    && useradd --uid 10002 --gid 10002 --groups 10001 --no-create-home --shell /usr/sbin/nologin atlas-verifier

# Pin the native verifier tools as well as the Python runtime. GEOS is loaded by
# Django's GEOS bindings; Osmium reconciles the same private, fingerprinted spool.
COPY requirements-native.txt /tmp/atlas-native-packages.txt
RUN apt-get update \
    && sed '/^#/d; /^$/d' /tmp/atlas-native-packages.txt \
        | xargs apt-get install --yes --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/atlas-native-packages.txt

WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --only-binary=:all: --requirement requirements.txt \
    && python -m pip check
COPY . .

USER 10001:10001
CMD ["gunicorn", "--bind=0.0.0.0:8000", "--workers=2", "--worker-tmp-dir=/dev/shm", "atlas_site.wsgi:application"]
