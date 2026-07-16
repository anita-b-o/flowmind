from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.metrics import OPERATIONS, registry
from app.main import app


client = TestClient(app)


def test_classify_requires_service_key() -> None:
    response = client.post("/classify", json={"text": "urgent lead"})
    assert response.status_code == 401


def test_classify_with_fake_provider() -> None:
    response = client.post(
        "/classify",
        headers={"x-service-api-key": "dev-ai-service-key"},
        json={"text": "urgent lead"},
    )
    assert response.status_code == 200
    assert response.json()["label"] == "high"


def test_trace_headers_are_generated_preserved_and_replaced() -> None:
    generated = client.post(
        "/classify",
        headers={"x-service-api-key": "dev-ai-service-key"},
        json={"text": "urgent lead"},
    )
    assert generated.headers["x-request-id"]
    assert generated.headers["x-correlation-id"]

    preserved = client.post(
        "/classify",
        headers={
            "x-service-api-key": "dev-ai-service-key",
            "x-request-id": "ai-request-123",
            "x-correlation-id": "ai-correlation-123",
        },
        json={"text": "urgent lead"},
    )
    assert preserved.headers["x-request-id"] == "ai-request-123"
    assert preserved.headers["x-correlation-id"] == "ai-correlation-123"

    replaced = client.post(
        "/classify",
        headers={
            "x-service-api-key": "dev-ai-service-key",
            "x-request-id": "bad",
            "x-correlation-id": "contains space",
        },
        json={"text": "urgent lead"},
    )
    assert replaced.headers["x-request-id"] != "bad"
    assert replaced.headers["x-correlation-id"] != "contains space"


def test_logs_include_trace_context_without_api_key_or_full_input(caplog) -> None:
    response = client.post(
        "/summarize",
        headers={
            "x-service-api-key": "dev-ai-service-key",
            "x-request-id": "log-request-123",
            "x-correlation-id": "log-correlation-123",
            "x-execution-id": "execution-123",
            "x-step-execution-id": "step-execution-123",
        },
        json={"text": "secret prompt body should not be logged"},
    )
    assert response.status_code == 200
    records = [record for record in caplog.records if record.name == "ai-service"]
    assert any(record.getMessage() == "ai.operation.completed" for record in records)
    structured = [getattr(record, "structured", {}) for record in records]
    assert any(entry.get("operation") == "summarize" and entry.get("provider") == "fake" for entry in structured)
    serialized = str(structured)
    assert "dev-ai-service-key" not in serialized
    assert "secret prompt body should not be logged" not in serialized


def test_metrics_disabled_returns_not_found() -> None:
    settings.metrics_enabled = False
    response = client.get("/metrics")
    assert response.status_code == 404


def test_metrics_endpoint_is_protected() -> None:
    settings.metrics_enabled = True
    settings.metrics_api_key = "ai-metrics-key-123"
    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 403
    response = client.get("/metrics", headers={"Authorization": "Bearer ai-metrics-key-123"})
    assert response.status_code == 200
    assert "flowmind_ai_requests_total" in response.text or "# HELP" in response.text
    assert "ai-metrics-key-123" not in response.text
    settings.metrics_enabled = False


def test_classify_metrics_increment_duration_and_fake_usage_zero() -> None:
    response = client.post(
        "/classify",
        headers={"x-service-api-key": "dev-ai-service-key"},
        json={"text": "urgent lead"},
    )
    assert response.status_code == 200
    output = registry_metrics()
    assert 'flowmind_ai_requests_total{operation="classify",provider="fake",outcome="success"}' in output or 'flowmind_ai_requests_total{operation="classify",outcome="success",provider="fake"}' in output
    assert "flowmind_ai_request_duration_seconds_bucket" in output
    assert 'flowmind_ai_input_tokens_total{operation="classify",provider="fake"} 0.0' in output
    assert 'flowmind_ai_output_tokens_total{operation="classify",provider="fake"} 0.0' in output
    assert 'flowmind_ai_cost_usd_total{operation="classify",provider="fake"} 0.0' in output


def test_ai_error_metrics_and_no_trace_ids_as_labels(monkeypatch) -> None:
    async def fail(*, task, payload):
        raise TimeoutError("timeout")

    monkeypatch.setattr("app.services.llm_service.llm_service.provider.complete_json", fail)
    error_client = TestClient(app, raise_server_exceptions=False)
    response = error_client.post(
        "/summarize",
        headers={
            "x-service-api-key": "dev-ai-service-key",
            "x-request-id": "metric-request-123",
            "x-correlation-id": "metric-correlation-123",
        },
        json={"text": "hello"},
    )
    assert response.status_code == 500
    output = registry_metrics()
    assert (
        'flowmind_ai_errors_total{operation="summarize",provider="fake",error_category="timeout"}'
        in output
        or 'flowmind_ai_errors_total{operation="summarize",error_category="timeout",provider="fake"}'
        in output
        or 'flowmind_ai_errors_total{error_category="timeout",operation="summarize",provider="fake"}'
        in output
    )
    assert "metric-request-123" not in output
    assert "metric-correlation-123" not in output


def test_operations_catalog_is_closed() -> None:
    assert OPERATIONS == {"classify", "extract", "summarize", "evaluate"}


def registry_metrics() -> str:
    from prometheus_client import generate_latest

    return generate_latest(registry).decode()
