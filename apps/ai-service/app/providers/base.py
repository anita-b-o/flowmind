from abc import ABC, abstractmethod
from typing import Any


class LlmProvider(ABC):
    @abstractmethod
    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError
