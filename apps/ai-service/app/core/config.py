from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    ai_service_api_key: str = "dev-ai-service-key"
    llm_provider: str = "fake"
    openai_api_key: str | None = None
    openai_model: str | None = None
    openai_timeout_ms: int = 30000
    openai_max_retries: int = 2
    openai_temperature: float = 0.2
    openai_max_output_tokens: int = 1000
    anthropic_api_key: str | None = None
    metrics_enabled: bool = False
    metrics_api_key: str = ""
    metrics_host: str = "127.0.0.1"
    ai_metrics_port: int = 9466
    api_docs_enabled: bool = False

    @model_validator(mode="after")
    def validate_production_security(self):
        if self.environment == "production":
            if len(self.ai_service_api_key) < 32 or self.ai_service_api_key == "dev-ai-service-key":
                raise ValueError("AI_SERVICE_API_KEY must contain at least 32 non-default characters in production")
            if self.llm_provider == "openai" and not self.openai_api_key:
                raise ValueError("OPENAI_API_KEY is required when LLM_PROVIDER=openai")
            if self.llm_provider == "anthropic" and not self.anthropic_api_key:
                raise ValueError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic")
        return self


settings = Settings()
