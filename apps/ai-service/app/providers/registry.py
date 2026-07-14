from app.core.config import settings
from app.providers.base import LlmProvider
from app.providers.fake_provider import FakeProvider


def get_provider() -> LlmProvider:
    if settings.llm_provider == "fake":
        return FakeProvider()
    raise ValueError(f"Unsupported LLM provider: {settings.llm_provider}")
