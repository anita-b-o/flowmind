from fastapi import APIRouter

from app.schemas.common import EvaluationRequest, EvaluationResponse

router = APIRouter()


@router.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest) -> EvaluationResponse:
    return EvaluationResponse(dataset=request.dataset, passed=True, score=1.0)
