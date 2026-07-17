from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ProviderResult:
    raw: dict[str, Any]
    usage: dict[str, int | float] | None = None
    model: str | None = None
    retries: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


class LlmProvider(ABC):
    @abstractmethod
    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> ProviderResult:
        raise NotImplementedError
