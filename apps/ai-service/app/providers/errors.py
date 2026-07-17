from __future__ import annotations


class ProviderError(Exception):
    status_code = 500
    error_category = "unknown"
    public_message = "AI provider request failed"
    retryable = False

    def __init__(
        self,
        public_message: str | None = None,
        *,
        status_code: int | None = None,
        error_category: str | None = None,
        retryable: bool | None = None,
    ) -> None:
        self.status_code = status_code if status_code is not None else self.status_code
        self.error_category = error_category or self.error_category
        self.public_message = public_message or self.public_message
        self.retryable = retryable if retryable is not None else self.retryable
        super().__init__(self.public_message)


class ProviderConfigurationError(ProviderError):
    status_code = 500
    error_category = "configuration"
    public_message = "AI provider is not configured correctly"


class ProviderTimeoutError(ProviderError):
    status_code = 504
    error_category = "timeout"
    public_message = "AI provider timed out"
    retryable = True


class ProviderAuthenticationError(ProviderError):
    status_code = 502
    error_category = "authentication"
    public_message = "AI provider authentication failed"


class ProviderRateLimitError(ProviderError):
    status_code = 429
    error_category = "rate_limit"
    public_message = "AI provider rate limit exceeded"
    retryable = True


class ProviderQuotaError(ProviderError):
    status_code = 429
    error_category = "rate_limit"
    public_message = "AI provider quota exceeded"


class ProviderInvalidResponseError(ProviderError):
    status_code = 502
    error_category = "validation"
    public_message = "AI provider returned an invalid response"


class ProviderTransientError(ProviderError):
    status_code = 502
    error_category = "external_5xx"
    public_message = "AI provider temporarily failed"
    retryable = True


class ProviderPermanentError(ProviderError):
    status_code = 502
    error_category = "external_4xx"
    public_message = "AI provider rejected the request"
