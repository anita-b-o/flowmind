from fastapi.testclient import TestClient

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
    assert any(entry.get("operation") == "summarize" and entry.get("provider") == "FakeProvider" for entry in structured)
    serialized = str(structured)
    assert "dev-ai-service-key" not in serialized
    assert "secret prompt body should not be logged" not in serialized
