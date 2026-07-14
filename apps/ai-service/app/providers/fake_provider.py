from typing import Any

from app.providers.base import LlmProvider


class FakeProvider(LlmProvider):
    async def complete_json(self, *, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text") or payload.get("input") or "")
        if task == "classify":
            label = "high" if "urgent" in text.lower() else "normal"
            return {"label": label, "confidence": 0.9, "reason": "fake provider rule"}
        if task == "extract":
            return {
                "data": {
                    "name": "Unknown",
                    "company": "Unknown",
                    "email": "unknown@example.com",
                    "intent": text[:120],
                }
            }
        if task == "summarize":
            return {"summary": text[:240]}
        return {}
