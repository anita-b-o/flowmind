from fastapi import APIRouter

from app.schemas.extract import ExtractRequest, ExtractResponse
from app.services.llm_service import llm_service

router = APIRouter()


@router.post("/extract", response_model=ExtractResponse)
async def extract(request: ExtractRequest) -> ExtractResponse:
    return await llm_service.extract(request)
