from typing import Any

from app.providers.base import LlmProvider, ProviderResult


class FakeProvider(LlmProvider):
    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> ProviderResult:
        text = str(payload.get("text") or payload.get("input") or "")
        if task == "classify":
            label = "high" if "urgent" in text.lower() else "normal"
            return ProviderResult(
                raw={"label": label, "confidence": 0.9, "reason": "fake provider rule"}
            )
        if task == "extract":
            return ProviderResult(
                raw={
                    "data": {
                        "name": "Unknown",
                        "company": "Unknown",
                        "email": "unknown@example.com",
                        "intent": text[:120],
                    }
                }
            )
        if task == "summarize":
            return ProviderResult(raw={"summary": text[:240]})
        if task == "evaluate":
            dataset = str(payload.get("dataset") or "")
            return ProviderResult(raw={"dataset": dataset, "passed": True, "score": 1.0})
        return ProviderResult(raw={})
