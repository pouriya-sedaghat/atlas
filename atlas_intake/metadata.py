"""Operation-local PBF metadata context; no HTTP policy or persistent pin data."""
import hashlib
import json
import math
import re
import ssl
from time import monotonic
from urllib.error import URLError
from urllib.parse import urlsplit
from uuid import uuid4

MAX_EVENTS = 40
MAX_EVENT_BYTES = 4096


def transport_reason(error):
    """Recognize only explicitly typed, bounded wrapping; never inspect messages."""
    seen = set()
    for _ in range(4):
        if id(error) in seen:
            break
        seen.add(id(error))
        if isinstance(error, ssl.SSLError):
            return "tls_error"
        if isinstance(error, TimeoutError):
            return "timeout"
        if isinstance(error, URLError) and isinstance(error.reason, BaseException):
            error = error.reason
            continue
        break
    return "transport_error"


def bounded_event(event):
    result = {}
    shortened = []
    prior_shortened = event.get("truncated_fields", [])
    if isinstance(prior_shortened, list):
        shortened = [name for name in prior_shortened[:20]
                     if isinstance(name, str) and name in {"target", "redirect_target"}]
    strings = {"event", "operation", "phase", "stage", "method", "trigger", "reason",
               "code", "outcome", "exception_class"}
    numbers = {"status", "redirects", "elapsed_seconds", "artifact", "generation", "event_number"}
    for key, value in event.items():
        if key in {"target", "redirect_target"} and isinstance(value, str):
            try:
                parsed = urlsplit(value)
                safe = (value.isascii() and parsed.scheme == "https"
                        and parsed.netloc.lower() in {"download.geofabrik.de", "download.geofabrik.de:443"}
                        and not parsed.query and not parsed.fragment
                        and not any(ord(c) <= 32 or c in "\\%?#" for c in value))
            except ValueError:
                safe = False
            if not safe:
                result[key] = "[invalid target omitted]"
                shortened.append(key)
            else:
                result[key] = value[:1024]
                if len(value) > 1024:
                    result[key + "_sha256"] = hashlib.sha256(value.encode()).hexdigest()
                    shortened.append(key)
        elif key in {"target_sha256", "redirect_target_sha256"} and isinstance(value, str):
            if re.fullmatch(r"[0-9a-f]{64}", value):
                result[key] = value
        elif key in strings and isinstance(value, str):
            result[key] = value[:120]
            if len(value) > 120:
                shortened.append(key)
        elif key in numbers and isinstance(value, (int, float)) and not isinstance(value, bool):
            if math.isfinite(value):
                result[key] = value
        elif key == "trace_truncated" and isinstance(value, bool):
            result[key] = value
    if shortened:
        result["truncated_fields"] = sorted(set(shortened))
    if len(json.dumps(result, sort_keys=True).encode()) > MAX_EVENT_BYTES:
        for key in strings:
            if key in result:
                result[key] = result[key][:40]
        for key in ("target", "redirect_target"):
            if key in result:
                result[key] = result[key][:256]
        result["trace_truncated"] = True
    if len(json.dumps(result, sort_keys=True).encode()) > MAX_EVENT_BYTES:
        raise ValueError("Metadata event exceeds its payload bound.")
    return result


class MetadataOperation:
    def __init__(self, phase, observer=None):
        self.phase = phase
        self.observer = observer
        self.operation = uuid4().hex
        self.redirects = 0
        self.target = ""
        self.dated_target = ""
        self.method = "HEAD"
        self.stage = "metadata"
        self.status = None
        self.reason = ""
        self.trigger = ""
        self.started = monotonic()
        self.request_started = self.started

    def context(self, **extra):
        return bounded_event({
            "operation": self.operation, "phase": self.phase, "stage": self.stage,
            "method": self.method, "target": self.target, "status": self.status,
            "reason": self.reason, "redirects": self.redirects, **extra,
        })

    def emit(self, event, **extra):
        if self.observer is not None:
            self.observer(self.context(event=event, **extra))

    def start(self):
        self.emit("operation_start")

    def request(self, target, method, kind):
        self.target, self.method = target, method
        self.stage = "sidecar" if kind == "sidecar" else "metadata"
        self.status, self.reason = None, ""
        self.request_started = monotonic()
        self.emit("request_start", trigger=self.trigger)

    def outcome(self, outcome, **extra):
        self.emit("request_end", outcome=outcome,
                  elapsed_seconds=round(monotonic() - self.request_started, 6), **extra)

    def finish(self, outcome, **extra):
        self.emit("operation_end", outcome=outcome,
                  elapsed_seconds=round(monotonic() - self.started, 6), **extra)
