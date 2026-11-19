import os
from pathlib import Path
from zoneinfo import ZoneInfo

from django.core.exceptions import ImproperlyConfigured


def secret(name):
    path = os.environ.get(f"{name}_FILE")
    value = Path(path).read_text().strip() if path else os.environ.get(name, "")
    if not value:
        raise ImproperlyConfigured(f"Set {name}_FILE or {name}.")
    return value


def items(name, default=""):
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


def byte_limit(name, default):
    value = int(os.environ.get(f"ATLAS_{name}_BYTES", default))
    if value <= 0:
        raise ImproperlyConfigured(f"ATLAS_{name}_BYTES must be positive.")
    return value


SECRET_KEY = secret("DJANGO_SECRET_KEY")
DEBUG = False
ALLOWED_HOSTS = items("ATLAS_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")
CSRF_TRUSTED_ORIGINS = items("ATLAS_CSRF_TRUSTED_ORIGINS")
ROOT_URLCONF = "atlas_site.urls"
WSGI_APPLICATION = "atlas_site.wsgi.application"

INSTALLED_APPS = [
    "django.contrib.auth", "django.contrib.contenttypes", "django.contrib.sessions",
    "django.contrib.messages", "django.contrib.staticfiles", "atlas_intake", "atlas_verification",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]
DATABASES = {"default": {
    "ENGINE": "django.db.backends.postgresql",
    "NAME": os.environ.get("POSTGRES_DB", "atlas"),
    "USER": os.environ.get("POSTGRES_USER", "atlas_app"),
    "PASSWORD": secret("POSTGRES_PASSWORD"),
    "HOST": os.environ.get("POSTGRES_HOST", "db"),
    "PORT": os.environ.get("POSTGRES_PORT", "5432"),
    "OPTIONS": {"connect_timeout": 5},
}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
WHITENOISE_USE_FINDERS = True
LOGIN_URL = "atlas_intake:login"
LOGIN_REDIRECT_URL = "atlas_intake:dashboard"
LOGOUT_REDIRECT_URL = "atlas_intake:login"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": f"django.contrib.auth.password_validation.{name}"}
    for name in ("UserAttributeSimilarityValidator", "MinimumLengthValidator",
                 "CommonPasswordValidator", "NumericPasswordValidator")
]
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = os.environ.get("ATLAS_SECURE_COOKIES") == "1"
SECURE_SSL_REDIRECT = os.environ.get("ATLAS_SSL_REDIRECT") == "1"
SECURE_REDIRECT_EXEMPT = [r"^health/$"]
if os.environ.get("ATLAS_TRUST_FORWARDED_PROTO") == "1":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

ATLAS_ZONE = os.environ.get("ATLAS_ZONE", "Asia/Tehran")
ZoneInfo(ATLAS_ZONE)
USE_TZ = True
TIME_ZONE = "UTC"
ATLAS_INBOX = Path(os.environ.get("ATLAS_INBOX", "/inbox"))
GIB = 1024**3
ATLAS_LIMITS = {
    "pbf": byte_limit("MAX_PBF", GIB),
    "poly": byte_limit("MAX_POLY", 2 * 1024**2),
    "run": byte_limit("MAX_RUN", 2 * GIB),
    "inbox": byte_limit("MAX_INBOX", 50 * GIB),
    "free": byte_limit("MIN_FREE", 20 * GIB),
}

ATLAS_VERIFICATION_ROOT = Path(os.environ.get("ATLAS_VERIFICATION_ROOT", "/verification"))
ATLAS_VERIFICATION_ATTEMPT_BYTES = byte_limit("VERIFICATION_ATTEMPT", 20 * GIB)
ATLAS_VERIFICATION_ROOT_BYTES = byte_limit("VERIFICATION_ROOT", 60 * GIB)
ATLAS_VERIFICATION_TIMEOUT = int(os.environ.get("ATLAS_VERIFICATION_TIMEOUT", "3600"))

if ATLAS_VERIFICATION_ATTEMPT_BYTES > 20 * GIB or ATLAS_VERIFICATION_ROOT_BYTES > 60 * GIB:
    raise ImproperlyConfigured("Verification storage limits exceed the approved pilot caps.")

if not 0 < ATLAS_VERIFICATION_TIMEOUT <= 3600:
    raise ImproperlyConfigured("Verification timeout exceeds the approved one-hour execution cap.")
