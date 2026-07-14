from fastapi import FastAPI

from app.api import classify, evaluate, extract, summarize
from app.core.config import settings
from app.core.security import ServiceAuthMiddleware

app = FastAPI(title="Automation AI Service", version="0.1.0")
app.add_middleware(ServiceAuthMiddleware)

app.include_router(classify.router)
app.include_router(extract.router)
app.include_router(summarize.router)
app.include_router(evaluate.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-service", "environment": settings.environment}


@app.get("/metrics")
def metrics() -> str:
    return "# metrics placeholder\n"
