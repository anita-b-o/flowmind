from fastapi import APIRouter

from app.core.metrics import observe_ai_operation
from app.schemas.common import EvaluationRequest, EvaluationResponse

router = APIRouter()


@router.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest) -> EvaluationResponse:
    async def callback():
        return {"dataset": request.dataset, "passed": True, "score": 1.0}, None

    raw = await observe_ai_operation("evaluate", "fake", callback)
    return EvaluationResponse(**raw)
