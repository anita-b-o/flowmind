import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.core.trace import current_trace


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "ai-service",
            "environment": settings.environment,
            "message": record.getMessage(),
            **{key: value for key, value in current_trace().items() if value},
        }
        extra = getattr(record, "structured", None)
        if isinstance(extra, dict):
            payload.update(extra)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


def log_event(event: str, **fields: Any) -> None:
    logging.getLogger("ai-service").info(event, extra={"structured": {**{key: value for key, value in current_trace().items() if value}, **fields}})
