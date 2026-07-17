from fastapi.testclient import TestClient
from prometheus_client import generate_latest

from app.core.metrics import registry
from app.main import app
from app.providers.base import ProviderResult
from app.providers.errors import ProviderAuthenticationError
from app.services.llm_service import llm_service


class DummyOpenAiProvider:
    async def complete_json(self, *, task, payload):
        if task == "classify":
            return ProviderResult(
                raw={"label": "high", "confidence": 0.9, "reason": "matched"},
                usage={"prompt_tokens": 12, "completion_tokens": 4, "cost_usd": 0},
                model="test-model",
                retries=1,
            )
        if task == "extract":
            return ProviderResult(
                raw={"data": {"email": "ada@example.com"}},
                usage={"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0},
                model="test-model",
            )
        if task == "summarize":
            return ProviderResult(
                raw={"summary": "Short summary."},
                usage={"prompt_tokens": 11, "completion_tokens": 3, "cost_usd": 0},
                model="test-model",
            )
        return ProviderResult(
            raw={"dataset": payload["dataset"], "passed": True, "score": 1.0},
            usage={"prompt_tokens": 2, "completion_tokens": 2, "cost_usd": 0},
            model="test-model",
        )


class FailingOpenAiProvider:
    async def complete_json(self, *, task, payload):
        raise ProviderAuthenticationError()


def test_openai_provider_preserves_fastapi_contracts(monkeypatch) -> None:
    monkeypatch.setattr(llm_service, "provider", DummyOpenAiProvider())
    client = TestClient(app)
    headers = {"x-service-api-key": "dev-ai-service-key"}

    classify = client.post(
        "/classify", headers=headers, json={"text": "urgent lead", "labels": ["high", "low"]}
    )
    extract = client.post(
        "/extract",
        headers=headers,
        json={
            "text": "Ada <ada@example.com>",
            "schema": {
                "type": "object",
                "properties": {"email": {"type": "string"}},
                "required": ["email"],
                "additionalProperties": False,
            },
        },
    )
    summarize = client.post("/summarize", headers=headers, json={"text": "hello world"})
    evaluate = client.post("/evaluate", headers=headers, json={"dataset": "smoke"})

    assert classify.status_code == 200
    assert classify.json()["usage"]["prompt_tokens"] == 12
    assert classify.json()["label"] == "high"
    assert extract.status_code == 200
    assert extract.json()["data"] == {"email": "ada@example.com"}
    assert summarize.status_code == 200
    assert summarize.json()["summary"] == "Short summary."
    assert evaluate.status_code == 200
    assert evaluate.json() == {"dataset": "smoke", "passed": True, "score": 1.0}
    output = registry_metrics()
    assert 'provider="openai"' in output
    assert "flowmind_ai_input_tokens_total" in output


def test_provider_errors_are_sanitized_for_clients(monkeypatch) -> None:
    monkeypatch.setattr(llm_service, "provider", FailingOpenAiProvider())
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/summarize",
        headers={"x-service-api-key": "dev-ai-service-key"},
        json={"text": "secret prompt body should not leak"},
    )

    assert response.status_code == 502
    assert response.json() == {
        "detail": "AI provider authentication failed",
        "errorCategory": "authentication",
    }
    assert "secret prompt body should not leak" not in response.text


def registry_metrics() -> str:
    return generate_latest(registry).decode()
