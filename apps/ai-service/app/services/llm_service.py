import time

from app.core.logging import log_event
from app.core.metrics import classify_error, observe_ai_operation
from app.providers.base import ProviderResult
from app.providers.registry import get_provider
from app.schemas.classify import ClassifyRequest, ClassifyResponse
from app.schemas.common import EvaluationRequest, EvaluationResponse, Usage
from app.schemas.extract import ExtractRequest, ExtractResponse
from app.schemas.summarize import SummarizeRequest, SummarizeResponse


class LlmService:
    def __init__(self) -> None:
        self.provider = get_provider()

    async def classify(self, request: ClassifyRequest) -> ClassifyResponse:
        return await self._run("classify", request, ClassifyResponse)

    async def extract(self, request: ExtractRequest) -> ExtractResponse:
        return await self._run("extract", request, ExtractResponse)

    async def summarize(self, request: SummarizeRequest) -> SummarizeResponse:
        return await self._run("summarize", request, SummarizeResponse)

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResponse:
        return await self._run("evaluate", request, EvaluationResponse, include_usage=False)

    async def _run(self, operation: str, request, response_type, include_usage: bool = True):
        started = time.perf_counter()
        provider = provider_name(self.provider)
        result: ProviderResult | None = None
        try:
            log_event("ai.request.received", operation=operation, provider=provider)

            async def callback():
                nonlocal result
                provider_result = await self.provider.complete_json(
                    task=operation, payload=request.model_dump()
                )
                result = normalize_provider_result(provider_result)
                return result.raw, result.usage

            raw = await observe_ai_operation(operation, provider, callback)
            duration_ms = int((time.perf_counter() - started) * 1000)
            usage = usage_from_result(result, duration_ms)
            log_event(
                "ai.operation.completed",
                operation=operation,
                provider=provider,
                model=result.model if result else None,
                durationMs=duration_ms,
                retryCount=result.retries if result else 0,
                promptTokens=usage.prompt_tokens,
                completionTokens=usage.completion_tokens,
            )
            if include_usage:
                return response_type(**raw, usage=usage)
            return response_type(**raw)
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event(
                "ai.operation.failed",
                operation=operation,
                provider=provider,
                model=result.model if result else None,
                durationMs=duration_ms,
                retryCount=result.retries if result else 0,
                errorCategory=classify_error(exc),
            )
            raise


llm_service = LlmService()


def provider_name(provider) -> str:
    name = provider.__class__.__name__.lower()
    if "fake" in name:
        return "fake"
    if "openai" in name:
        return "openai"
    if "anthropic" in name:
        return "anthropic"
    return "fake"


def normalize_provider_result(value) -> ProviderResult:
    if isinstance(value, ProviderResult):
        return value
    if isinstance(value, dict):
        return ProviderResult(raw=value)
    raise TypeError("Provider returned an invalid result")


def usage_from_result(result: ProviderResult | None, duration_ms: int) -> Usage:
    usage = result.usage if result else {}
    return Usage(
        prompt_tokens=int(usage.get("prompt_tokens", 0) if usage else 0),
        completion_tokens=int(usage.get("completion_tokens", 0) if usage else 0),
        cost_usd=float(usage.get("cost_usd", 0) if usage else 0),
        latency_ms=duration_ms,
    )
