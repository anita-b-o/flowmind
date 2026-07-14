from typing import Any

from app.providers.base import LlmProvider


class OpenAiProvider(LlmProvider):
    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("OpenAI provider is intentionally deferred behind the provider interface")
