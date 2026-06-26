"""
Paylode Python SDK — Custom Exceptions
"""


class PaylodeError(Exception):
    """Base exception for all Paylode SDK errors."""

    def __init__(self, message: str, code: str = "PAYLODE_ERROR", status_code: int = 0, raw=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.raw = raw

    def __repr__(self):
        return f"PaylodeError(code={self.code!r}, message={self.message!r}, status_code={self.status_code})"


class PaylodeAuthError(PaylodeError):
    """Raised when authentication fails — invalid or missing API key."""

    def __init__(self, message="Invalid or missing API key", raw=None):
        super().__init__(message, code="AUTH_ERROR", status_code=401, raw=raw)


class PaylodeValidationError(PaylodeError):
    """Raised when request parameters fail validation before hitting the API."""

    def __init__(self, message: str, field: str = None):
        super().__init__(message, code="VALIDATION_ERROR", status_code=400)
        self.field = field

    def __repr__(self):
        return f"PaylodeValidationError(field={self.field!r}, message={self.message!r})"


class PaylodeAPIError(PaylodeError):
    """Raised when the Paylode API returns a non-2xx response."""

    def __init__(self, message: str, code: str, status_code: int, raw=None):
        super().__init__(message, code=code, status_code=status_code, raw=raw)
