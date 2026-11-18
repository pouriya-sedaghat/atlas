FROM docker.io/library/python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=atlas_site.settings

RUN groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin atlas

WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --only-binary=:all: --requirement requirements.txt \
    && python -m pip check
COPY . .

USER 10001:10001
CMD ["gunicorn", "--bind=0.0.0.0:8000", "--workers=2", "--worker-tmp-dir=/dev/shm", "atlas_site.wsgi:application"]
