import hmac
import time
from collections.abc import Callable
from typing import Awaitable

from fastapi import HTTPException, Request
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from starlette.responses import Response

from app.core.config import settings

AI_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60)
OPERATIONS = {"classify", "extract", "summarize", "evaluate"}
PROVIDERS = {"fake", "openai", "anthropic"}
ERROR_CATEGORIES = {
    "validation",
    "authentication",
    "authorization",
    "rate_limit",
    "timeout",
    "connection",
    "external_4xx",
    "external_5xx",
    "ssrf",
    "configuration",
    "ambiguous_effect",
    "database",
    "redis",
    "unknown",
}

registry = CollectorRegistry()

ai_requests = Counter(
    "flowmind_ai_requests_total",
    "AI operation requests.",
    ("operation", "provider", "outcome"),
    registry=registry,
)
ai_duration = Histogram(
    "flowmind_ai_request_duration_seconds",
    "AI operation duration.",
    ("operation", "provider", "outcome"),
    buckets=AI_BUCKETS,
    registry=registry,
)
ai_errors = Counter(
    "flowmind_ai_errors_total",
    "AI operation errors.",
    ("operation", "provider", "error_category"),
    registry=registry,
)
ai_input_tokens = Counter(
    "flowmind_ai_input_tokens_total",
    "AI input tokens reported by provider.",
    ("operation", "provider"),
    registry=registry,
)
ai_output_tokens = Counter(
    "flowmind_ai_output_tokens_total",
    "AI output tokens reported by provider.",
    ("operation", "provider"),
    registry=registry,
)
ai_cost_usd = Counter(
    "flowmind_ai_cost_usd_total",
    "AI cost in USD reported by provider.",
    ("operation", "provider"),
    registry=registry,
)


async def protected_metrics(request: Request) -> Response:
    if not settings.metrics_enabled:
        raise HTTPException(status_code=404, detail="Not found")
    if not _has_credentials(request):
        raise HTTPException(status_code=401, detail="Missing metrics credentials")
    if not _authorized(request):
        raise HTTPException(status_code=403, detail="Invalid metrics credentials")
    return Response(generate_latest(registry), media_type="text/plain; version=0.0.4")


async def observe_ai_operation(
    operation: str,
    provider: str,
    callback: Callable[[], Awaitable[tuple[dict, dict | None]]],
) -> dict:
    safe_operation = operation if operation in OPERATIONS else "evaluate"
    safe_provider = provider if provider in PROVIDERS else "fake"
    started = time.perf_counter()
    try:
        raw, usage = await callback()
        duration = time.perf_counter() - started
        ai_requests.labels(safe_operation, safe_provider, "success").inc()
        ai_duration.labels(safe_operation, safe_provider, "success").observe(duration)
        ai_input_tokens.labels(safe_operation, safe_provider).inc(_usage_number(usage, "prompt_tokens"))
        ai_output_tokens.labels(safe_operation, safe_provider).inc(_usage_number(usage, "completion_tokens"))
        ai_cost_usd.labels(safe_operation, safe_provider).inc(_usage_number(usage, "cost_usd"))
        return raw
    except Exception as exc:
        duration = time.perf_counter() - started
        category = classify_error(exc)
        ai_requests.labels(safe_operation, safe_provider, "error").inc()
        ai_duration.labels(safe_operation, safe_provider, "error").observe(duration)
        ai_errors.labels(safe_operation, safe_provider, category).inc()
        raise


def classify_error(error: Exception) -> str:
    status = getattr(error, "status_code", None)
    if status in {400, 422}:
        return "validation"
    if status == 401:
        return "authentication"
    if status == 403:
        return "authorization"
    if status == 429:
        return "rate_limit"
    if isinstance(status, int) and 400 <= status < 500:
        return "external_4xx"
    if isinstance(status, int) and status >= 500:
        return "external_5xx"
    message = str(error).lower()
    if "timeout" in message:
        return "timeout"
    if "connect" in message or "socket" in message:
        return "connection"
    if "config" in message or "unsupported llm provider" in message:
        return "configuration"
    return "unknown"


def _usage_number(usage: dict | None, key: str) -> float:
    if not usage:
        return 0
    value = usage.get(key, 0)
    return float(value) if isinstance(value, int | float) else 0


def _has_credentials(request: Request) -> bool:
    return bool(_bearer_token(request) or request.headers.get("x-metrics-api-key"))


def _authorized(request: Request) -> bool:
    expected = settings.metrics_api_key
    presented = _bearer_token(request) or request.headers.get("x-metrics-api-key") or ""
    return bool(expected and presented and hmac.compare_digest(presented, expected))


def _bearer_token(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:]
    return None
