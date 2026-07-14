from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.config import settings


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path in {"/health", "/metrics", "/docs", "/openapi.json"}:
            return await call_next(request)
        api_key = request.headers.get("x-service-api-key")
        if api_key != settings.ai_service_api_key:
            return JSONResponse({"detail": "Invalid service API key"}, status_code=401)
        return await call_next(request)
