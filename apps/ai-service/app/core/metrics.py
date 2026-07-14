from dataclasses import dataclass


@dataclass
class LlmUsage:
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float
    latency_ms: int
