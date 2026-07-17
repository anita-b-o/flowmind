import httpx
import pytest

from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderInvalidResponseError,
    ProviderPermanentError,
    ProviderQuotaError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from app.providers.openai_provider import OPENAI_RESPONSES_URL, OpenAiProvider


class FakeAsyncClient:
    calls: list[dict]
    queue: list

    def __init__(self, *, timeout):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, url, *, headers, json):
        self.__class__.calls.append({"url": url, "headers": headers, "json": json})
        item = self.__class__.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def reset_fake_client():
    FakeAsyncClient.calls = []
    FakeAsyncClient.queue = []
    yield


def provider(**overrides) -> OpenAiProvider:
    return OpenAiProvider(
        api_key=overrides.pop("api_key", "test-openai-key"),
        model=overrides.pop("model", "test-model"),
        timeout_ms=overrides.pop("timeout_ms", 1000),
        max_retries=overrides.pop("max_retries", 2),
        temperature=overrides.pop("temperature", 0.2),
        max_output_tokens=overrides.pop("max_output_tokens", 200),
        client_factory=overrides.pop("client_factory", FakeAsyncClient),
        sleep=overrides.pop("sleep", noop_sleep),
        **overrides,
    )


async def noop_sleep(_seconds: float) -> None:
    return None


def openai_response(status_code: int, body: dict) -> httpx.Response:
    request = httpx.Request("POST", OPENAI_RESPONSES_URL)
    return httpx.Response(status_code=status_code, json=body, request=request)


def success_body(text: str, *, input_tokens: int = 7, output_tokens: int = 3) -> dict:
    return {
        "output": [{"content": [{"type": "output_text", "text": text}]}],
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    }


@pytest.mark.asyncio
async def test_classify_builds_responses_request_and_returns_usage() -> None:
    FakeAsyncClient.queue = [
        openai_response(200, success_body('{"label":"high","confidence":0.91,"reason":"matched"}'))
    ]

    result = await provider().complete_json(
        task="classify",
        payload={"text": "urgent lead", "labels": ["high", "normal"]},
    )

    assert result.raw == {"label": "high", "confidence": 0.91, "reason": "matched"}
    assert result.usage == {"prompt_tokens": 7, "completion_tokens": 3, "cost_usd": 0}
    assert result.model == "test-model"
    assert result.retries == 0
    call = FakeAsyncClient.calls[0]
    assert call["url"] == OPENAI_RESPONSES_URL
    assert call["headers"]["Authorization"] == "Bearer test-openai-key"
    assert call["json"]["model"] == "test-model"
    assert call["json"]["temperature"] == 0.2
    assert call["json"]["max_output_tokens"] == 200
    assert call["json"]["text"]["format"]["type"] == "json_schema"
    assert call["json"]["text"]["format"]["strict"] is True


def test_missing_api_key_is_invalid_configuration() -> None:
    with pytest.raises(ProviderConfigurationError):
        provider(api_key="")


def test_missing_model_is_invalid_configuration() -> None:
    with pytest.raises(ProviderConfigurationError):
        provider(model="")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("timeout_ms", 0),
        ("max_retries", 6),
        ("temperature", 2.1),
        ("max_output_tokens", 0),
    ],
)
def test_invalid_numeric_configuration(field: str, value: int | float) -> None:
    with pytest.raises(ProviderConfigurationError):
        provider(**{field: value})


@pytest.mark.asyncio
async def test_timeout_is_retryable_and_limited() -> None:
    FakeAsyncClient.queue = [
        httpx.TimeoutException("boom"),
        httpx.TimeoutException("boom"),
    ]

    with pytest.raises(ProviderTimeoutError):
        await provider(max_retries=1).complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )

    assert len(FakeAsyncClient.calls) == 2


@pytest.mark.asyncio
async def test_rate_limit_retries_then_succeeds() -> None:
    FakeAsyncClient.queue = [
        openai_response(429, {"error": {"code": "rate_limit_exceeded"}}),
        openai_response(200, success_body('{"summary":"ok"}')),
    ]

    result = await provider(max_retries=1).complete_json(
        task="summarize", payload={"text": "hello", "max_words": 20}
    )

    assert result.raw == {"summary": "ok"}
    assert result.retries == 1
    assert len(FakeAsyncClient.calls) == 2


@pytest.mark.asyncio
async def test_rate_limit_fails_after_retry_budget() -> None:
    FakeAsyncClient.queue = [
        openai_response(429, {"error": {"code": "rate_limit_exceeded"}}),
        openai_response(429, {"error": {"code": "rate_limit_exceeded"}}),
    ]

    with pytest.raises(ProviderRateLimitError):
        await provider(max_retries=1).complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )

    assert len(FakeAsyncClient.calls) == 2


@pytest.mark.asyncio
async def test_authentication_error_is_not_retried() -> None:
    FakeAsyncClient.queue = [openai_response(401, {"error": {"code": "invalid_api_key"}})]

    with pytest.raises(ProviderAuthenticationError):
        await provider().complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )

    assert len(FakeAsyncClient.calls) == 1


@pytest.mark.asyncio
async def test_quota_error_is_not_retried() -> None:
    FakeAsyncClient.queue = [openai_response(429, {"error": {"code": "insufficient_quota"}})]

    with pytest.raises(ProviderQuotaError):
        await provider().complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )

    assert len(FakeAsyncClient.calls) == 1


@pytest.mark.asyncio
async def test_permanent_4xx_is_not_retried() -> None:
    FakeAsyncClient.queue = [openai_response(400, {"error": {"code": "bad_request"}})]

    with pytest.raises(ProviderPermanentError):
        await provider().complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )

    assert len(FakeAsyncClient.calls) == 1


@pytest.mark.asyncio
async def test_transient_5xx_retries_then_succeeds() -> None:
    FakeAsyncClient.queue = [
        openai_response(500, {"error": {"code": "server_error"}}),
        openai_response(200, success_body('{"summary":"ok"}')),
    ]

    result = await provider(max_retries=1).complete_json(
        task="summarize", payload={"text": "hello", "max_words": 20}
    )

    assert result.raw == {"summary": "ok"}
    assert result.retries == 1


@pytest.mark.asyncio
async def test_invalid_json_response_is_rejected() -> None:
    FakeAsyncClient.queue = [openai_response(200, success_body('{"summary":'))]

    with pytest.raises(ProviderInvalidResponseError):
        await provider().complete_json(
            task="summarize", payload={"text": "hello", "max_words": 20}
        )


@pytest.mark.asyncio
async def test_structured_extract_validates_schema_strictly() -> None:
    FakeAsyncClient.queue = [
        openai_response(
            200,
            success_body('{"data":{"email":"not-an-email"}}'),
        )
    ]

    with pytest.raises(ProviderInvalidResponseError):
        await provider().complete_json(
            task="extract",
            payload={
                "text": "lead",
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "email": {"type": "string", "format": "email"},
                        "name": {"type": "string"},
                    },
                    "required": ["email", "name"],
                    "additionalProperties": False,
                },
            },
        )


@pytest.mark.asyncio
async def test_classify_rejects_label_outside_allowed_values() -> None:
    FakeAsyncClient.queue = [
        openai_response(200, success_body('{"label":"other","confidence":0.8,"reason":"x"}'))
    ]

    with pytest.raises(ProviderInvalidResponseError):
        await provider().complete_json(
            task="classify",
            payload={"text": "urgent lead", "labels": ["high", "normal"]},
        )


def test_public_errors_do_not_include_secret_material() -> None:
    error = ProviderAuthenticationError()

    assert "test-openai-key" not in str(error)
    assert "Authorization" not in str(error)
