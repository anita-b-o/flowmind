from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from jsonschema import Draft202012Validator, ValidationError

from app.core.config import settings
from app.providers.base import LlmProvider, ProviderResult
from app.providers.errors import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderInvalidResponseError,
    ProviderPermanentError,
    ProviderQuotaError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderTransientError,
)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


class OpenAiProvider(LlmProvider):
    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.openai_api_key
        self.model = model if model is not None else settings.openai_model
        self.timeout_ms = timeout_ms if timeout_ms is not None else settings.openai_timeout_ms
        self.max_retries = max_retries if max_retries is not None else settings.openai_max_retries
        self.temperature = temperature if temperature is not None else settings.openai_temperature
        self.max_output_tokens = (
            max_output_tokens
            if max_output_tokens is not None
            else settings.openai_max_output_tokens
        )
        self.client_factory = client_factory
        self.sleep = sleep
        self._validate_config()

    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> ProviderResult:
        request_body = self._build_request(task, payload)
        response_json, retries = await self._request_with_retries(request_body)
        parsed = self._parse_response_json(response_json)
        self._validate_task_output(task, payload, parsed)
        return ProviderResult(
            raw=parsed,
            usage=_usage(response_json.get("usage")),
            model=self.model,
            retries=retries,
        )

    def _validate_config(self) -> None:
        if not self.api_key:
            raise ProviderConfigurationError("OpenAI API key is missing")
        if not self.model:
            raise ProviderConfigurationError("OpenAI model is missing")
        if not 100 <= self.timeout_ms <= 300000:
            raise ProviderConfigurationError("OpenAI timeout must be between 100 and 300000 ms")
        if not 0 <= self.max_retries <= 5:
            raise ProviderConfigurationError("OpenAI max retries must be between 0 and 5")
        if not 0 <= self.temperature <= 2:
            raise ProviderConfigurationError("OpenAI temperature must be between 0 and 2")
        if not 1 <= self.max_output_tokens <= 100000:
            raise ProviderConfigurationError("OpenAI max output tokens must be positive")

    def _build_request(self, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        schema = _response_schema(task, payload)
        return {
            "model": self.model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": _system_prompt(task)}]},
                {"role": "user", "content": [{"type": "input_text", "text": _user_prompt(task, payload)}]},
            ],
            "temperature": self.temperature,
            "max_output_tokens": self.max_output_tokens,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": f"flowmind_{task}",
                    "schema": schema,
                    "strict": True,
                }
            },
        }

    async def _request_with_retries(self, request_body: dict[str, Any]) -> tuple[dict[str, Any], int]:
        retries = 0
        timeout = httpx.Timeout(self.timeout_ms / 1000)
        async with self.client_factory(timeout=timeout) as client:
            while True:
                try:
                    response = await client.post(
                        OPENAI_RESPONSES_URL,
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        json=request_body,
                    )
                    if response.status_code < 400:
                        return response.json(), retries
                    error = _error_from_response(response)
                except httpx.TimeoutException:
                    error = ProviderTimeoutError()
                except httpx.TransportError:
                    error = ProviderTransientError("AI provider connection failed")
                except json.JSONDecodeError as exc:
                    raise ProviderInvalidResponseError() from exc

                if not getattr(error, "retryable", False) or retries >= self.max_retries:
                    raise error
                retries += 1
                await self.sleep(min(0.25 * (2 ** (retries - 1)), 4.0))

    def _parse_response_json(self, response_json: dict[str, Any]) -> dict[str, Any]:
        output_text = response_json.get("output_text")
        if not isinstance(output_text, str):
            output_text = _extract_output_text(response_json)
        if not output_text:
            raise ProviderInvalidResponseError()
        try:
            parsed = json.loads(output_text)
        except json.JSONDecodeError as exc:
            raise ProviderInvalidResponseError() from exc
        if not isinstance(parsed, dict):
            raise ProviderInvalidResponseError()
        return parsed

    def _validate_task_output(
        self, task: str, payload: dict[str, Any], parsed: dict[str, Any]
    ) -> None:
        schema = _response_schema(task, payload)
        try:
            Draft202012Validator.check_schema(schema)
            Draft202012Validator(schema).validate(parsed)
            if task == "extract" and payload.get("output_schema"):
                output_schema = payload["output_schema"]
                Draft202012Validator.check_schema(output_schema)
                Draft202012Validator(output_schema).validate(parsed["data"])
        except (ValidationError, TypeError, KeyError) as exc:
            raise ProviderInvalidResponseError() from exc

        if task == "classify":
            labels = payload.get("labels") or []
            if parsed["label"] not in labels:
                raise ProviderInvalidResponseError()


def _response_schema(task: str, payload: dict[str, Any]) -> dict[str, Any]:
    if task == "classify":
        labels = payload.get("labels") or ["high", "normal", "low"]
        return {
            "type": "object",
            "properties": {
                "label": {"type": "string", "enum": labels},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "reason": {"type": "string"},
            },
            "required": ["label", "confidence", "reason"],
            "additionalProperties": False,
        }
    if task == "extract":
        output_schema = payload.get("output_schema") or {"type": "object"}
        return {
            "type": "object",
            "properties": {"data": output_schema},
            "required": ["data"],
            "additionalProperties": False,
        }
    if task == "summarize":
        return {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
            "additionalProperties": False,
        }
    if task == "evaluate":
        return {
            "type": "object",
            "properties": {
                "dataset": {"type": "string"},
                "passed": {"type": "boolean"},
                "score": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["dataset", "passed", "score"],
            "additionalProperties": False,
        }
    raise ProviderPermanentError("Unsupported AI operation")


def _system_prompt(task: str) -> str:
    return (
        "You are FlowMind's AI service. Return only valid JSON matching the provided schema. "
        f"Current operation: {task}."
    )


def _user_prompt(task: str, payload: dict[str, Any]) -> str:
    if task == "classify":
        labels = ", ".join(str(label) for label in payload.get("labels", []))
        return f"Classify this text into one of these labels: {labels}\n\nText:\n{payload['text']}"
    if task == "extract":
        return f"Extract structured data from this text.\n\nText:\n{payload['text']}"
    if task == "summarize":
        return f"Summarize this text in at most {payload.get('max_words', 80)} words.\n\nText:\n{payload['text']}"
    if task == "evaluate":
        return f"Evaluate this dataset name or description and return pass/fail metadata.\n\nDataset:\n{payload['dataset']}"
    raise ProviderPermanentError("Unsupported AI operation")


def _extract_output_text(response_json: dict[str, Any]) -> str | None:
    output = response_json.get("output")
    if not isinstance(output, list):
        return None
    chunks: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks) or None


def _error_from_response(response: httpx.Response):
    status = response.status_code
    code = _provider_error_code(response)
    if status in {401, 403}:
        return ProviderAuthenticationError()
    if status == 429 and code == "insufficient_quota":
        return ProviderQuotaError()
    if status == 429:
        return ProviderRateLimitError()
    if status in {408, 409} or status >= 500:
        return ProviderTransientError(status_code=502)
    return ProviderPermanentError(status_code=502)


def _provider_error_code(response: httpx.Response) -> str:
    try:
        body = response.json()
    except json.JSONDecodeError:
        return ""
    error = body.get("error") if isinstance(body, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) else ""


def _usage(raw_usage: Any) -> dict[str, int | float]:
    if not isinstance(raw_usage, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0}
    return {
        "prompt_tokens": _number(raw_usage.get("input_tokens")),
        "completion_tokens": _number(raw_usage.get("output_tokens")),
        "cost_usd": 0,
    }


def _number(value: Any) -> int | float:
    return value if isinstance(value, int | float) else 0
