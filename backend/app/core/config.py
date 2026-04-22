import os
from typing import Optional

from dotenv import load_dotenv
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

env_path = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    ".env",
)
load_dotenv(dotenv_path=env_path)


class Settings(BaseSettings):
    SUPABASE_URL: Optional[str] = None
    SUPABASE_KEY: Optional[str] = None
    JWT_SECRET: Optional[str] = None
    QDRANT_HOST: Optional[str] = None
    DEV_BYPASS_AUTH: bool = True

    # Phase 7 — AI / GenAI
    OPENAI_API_KEY: Optional[str] = None
    GEMINI_API_KEY: Optional[str] = None
    GEMINI_IMAGE_MODEL: str = "gemini-3.1-flash-image-preview"
    AI_RATE_LIMIT_PER_HOUR: int = 10

    model_config = SettingsConfigDict(
        env_file=env_path,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator(
        "SUPABASE_URL", "SUPABASE_KEY", "JWT_SECRET", "QDRANT_HOST",
        "OPENAI_API_KEY", "GEMINI_API_KEY", "GEMINI_IMAGE_MODEL",
        mode="before",
    )
    @classmethod
    def normalize_blank_strings(cls, value: Optional[str]) -> Optional[str]:
        if isinstance(value, str) and not value.strip():
            return None
        return value


settings = Settings()
