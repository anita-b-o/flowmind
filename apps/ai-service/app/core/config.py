from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    ai_service_api_key: str = "dev-ai-service-key"
    llm_provider: str = "fake"
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None


settings = Settings()
