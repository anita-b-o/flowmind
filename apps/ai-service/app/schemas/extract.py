from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import Usage


class ExtractRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(min_length=1)
    output_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")


class ExtractResponse(BaseModel):
    data: dict[str, Any]
    usage: Usage = Usage()
