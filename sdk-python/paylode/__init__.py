"""
Paylode Python SDK
Official server-side SDK for Paylode Services Limited
CBN Licensed PSSP — paylodeservices.com
Version: 1.0.0
"""

from .client import Paylode
from .exceptions import PaylodeError, PaylodeAuthError, PaylodeValidationError, PaylodeAPIError
from .constants import KYC_LIMITS

__version__ = "1.0.0"
__all__ = [
    "Paylode",
    "PaylodeError",
    "PaylodeAuthError",
    "PaylodeValidationError",
    "PaylodeAPIError",
    "KYC_LIMITS",
]
