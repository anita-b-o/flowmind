from pydantic import BaseModel, Field

from app.schemas.common import Usage


class SummarizeRequest(BaseModel):
    text: str = Field(min_length=1)
    max_words: int = Field(default=80, ge=5, le=500)


class SummarizeResponse(BaseModel):
    summary: str
    usage: Usage = Usage()
