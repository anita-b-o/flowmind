from pydantic import BaseModel, Field


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0
    latency_ms: int = 0


class EvaluationRequest(BaseModel):
    dataset: str = Field(min_length=1)


class EvaluationResponse(BaseModel):
    dataset: str
    passed: bool
    score: float
