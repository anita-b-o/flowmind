import time

from app.core.logging import log_event
from app.core.metrics import classify_error, observe_ai_operation
from app.providers.registry import get_provider
from app.schemas.classify import ClassifyRequest, ClassifyResponse
from app.schemas.common import Usage
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

    async def _run(self, operation: str, request, response_type):
        started = time.perf_counter()
        provider = provider_name(self.provider)
        try:
            log_event("ai.request.received", operation=operation, provider=provider)

            async def callback():
                return await self.provider.complete_json(task=operation, payload=request.model_dump()), None

            raw = await observe_ai_operation(operation, provider, callback)
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event("ai.operation.completed", operation=operation, provider=provider, durationMs=duration_ms)
            return response_type(**raw, usage=Usage(latency_ms=duration_ms))
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event("ai.operation.failed", operation=operation, provider=provider, durationMs=duration_ms, errorCategory=classify_error(exc))
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
