from pydantic import BaseModel, Field

from app.schemas.common import Usage


class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1)
    labels: list[str] = Field(default_factory=lambda: ["high", "normal", "low"])


class ClassifyResponse(BaseModel):
    label: str
    confidence: float = Field(ge=0, le=1)
    reason: str
    usage: Usage = Usage()
