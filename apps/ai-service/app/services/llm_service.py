import time

from app.providers.registry import get_provider
from app.schemas.classify import ClassifyRequest, ClassifyResponse
from app.schemas.common import Usage
from app.schemas.extract import ExtractRequest, ExtractResponse
from app.schemas.summarize import SummarizeRequest, SummarizeResponse


class LlmService:
    def __init__(self) -> None:
        self.provider = get_provider()

    async def classify(self, request: ClassifyRequest) -> ClassifyResponse:
        started = time.perf_counter()
        raw = await self.provider.complete_json(task="classify", payload=request.model_dump())
        return ClassifyResponse(
            **raw,
            usage=Usage(latency_ms=int((time.perf_counter() - started) * 1000)),
        )

    async def extract(self, request: ExtractRequest) -> ExtractResponse:
        started = time.perf_counter()
        raw = await self.provider.complete_json(task="extract", payload=request.model_dump())
        return ExtractResponse(
            **raw,
            usage=Usage(latency_ms=int((time.perf_counter() - started) * 1000)),
        )

    async def summarize(self, request: SummarizeRequest) -> SummarizeResponse:
        started = time.perf_counter()
        raw = await self.provider.complete_json(task="summarize", payload=request.model_dump())
        return SummarizeResponse(
            **raw,
            usage=Usage(latency_ms=int((time.perf_counter() - started) * 1000)),
        )


llm_service = LlmService()
