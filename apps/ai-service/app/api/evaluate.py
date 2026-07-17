from fastapi import APIRouter

from app.schemas.common import EvaluationRequest, EvaluationResponse
from app.services.llm_service import llm_service

router = APIRouter()


@router.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest) -> EvaluationResponse:
    return await llm_service.evaluate(request)
