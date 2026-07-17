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


settings = Settings()
