import re
import time
import uuid
from contextvars import ContextVar
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

TRACE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")

request_id_var: ContextVar[str] = ContextVar("request_id", default="")
correlation_id_var: ContextVar[str] = ContextVar("correlation_id", default="")
execution_id_var: ContextVar[str] = ContextVar("execution_id", default="")
step_execution_id_var: ContextVar[str] = ContextVar("step_execution_id", default="")


def valid_or_new(value: str | None) -> str:
    return value if value and TRACE_ID_RE.match(value) else str(uuid.uuid4())


def current_trace() -> dict[str, str]:
    return {
        "requestId": request_id_var.get(),
        "correlationId": correlation_id_var.get(),
        "executionId": execution_id_var.get(),
        "stepExecutionId": step_execution_id_var.get(),
    }


class TraceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Any) -> Response:
        request_id = valid_or_new(request.headers.get("x-request-id"))
        correlation_id = valid_or_new(request.headers.get("x-correlation-id"))
        token_request = request_id_var.set(request_id)
        token_correlation = correlation_id_var.set(correlation_id)
        token_execution = execution_id_var.set(request.headers.get("x-execution-id", ""))
        token_step = step_execution_id_var.set(request.headers.get("x-step-execution-id", ""))
        started = time.perf_counter()
        try:
            response = await call_next(request)
            return response
        finally:
            duration_ms = int((time.perf_counter() - started) * 1000)
            request.state.duration_ms = duration_ms
            if "response" in locals():
                response.headers["x-request-id"] = request_id
                response.headers["x-correlation-id"] = correlation_id
            request_id_var.reset(token_request)
            correlation_id_var.reset(token_correlation)
            execution_id_var.reset(token_execution)
            step_execution_id_var.reset(token_step)
