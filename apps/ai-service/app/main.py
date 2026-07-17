from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

from app.api import classify, evaluate, extract, summarize
from app.core.config import settings
from app.core.logging import configure_logging, log_event
from app.core.metrics import protected_metrics
from app.core.security import ServiceAuthMiddleware
from app.core.trace import TraceMiddleware
from app.providers.errors import ProviderError

configure_logging()
app = FastAPI(title="Automation AI Service", version="0.1.0")
app.add_middleware(ServiceAuthMiddleware)
app.add_middleware(TraceMiddleware)

app.include_router(classify.router)
app.include_router(extract.router)
app.include_router(summarize.router)
app.include_router(evaluate.router)


@app.exception_handler(ProviderError)
async def provider_error_handler(_request: Request, exc: ProviderError) -> JSONResponse:
    log_event("ai.provider.error.sanitized", errorCategory=exc.error_category)
    return JSONResponse(
        {"detail": exc.public_message, "errorCategory": exc.error_category},
        status_code=exc.status_code,
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-service", "environment": settings.environment}


@app.get("/metrics")
async def metrics(request: Request):
    return await protected_metrics(request)
