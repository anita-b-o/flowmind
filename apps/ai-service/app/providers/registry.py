from app.core.config import settings
from app.providers.base import LlmProvider
from app.providers.fake_provider import FakeProvider
from app.providers.openai_provider import OpenAiProvider


def get_provider() -> LlmProvider:
    if settings.llm_provider == "fake":
        return FakeProvider()
    if settings.llm_provider == "openai":
        return OpenAiProvider()
    raise ValueError(f"Unsupported LLM provider: {settings.llm_provider}")
