import time

from app.core.logging import log_event
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
        try:
            log_event("ai.request.received", operation=operation, provider=self.provider.__class__.__name__)
            raw = await self.provider.complete_json(task=operation, payload=request.model_dump())
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event("ai.operation.completed", operation=operation, provider=self.provider.__class__.__name__, durationMs=duration_ms)
            return response_type(**raw, usage=Usage(latency_ms=duration_ms))
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            log_event("ai.operation.failed", operation=operation, provider=self.provider.__class__.__name__, durationMs=duration_ms, errorCategory=exc.__class__.__name__)
            raise


llm_service = LlmService()
