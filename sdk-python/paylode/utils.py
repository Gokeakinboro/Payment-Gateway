"""
Paylode Python SDK — Utility helpers
"""

import hashlib
import hmac
import os
import time
import secrets
import json
from typing import Union


def generate_ref(prefix: str = "TXN") -> str:
    """
    Generate a unique transaction reference.

    Args:
        prefix: String prefix for the reference (default: 'TXN')

    Returns:
        A unique reference string e.g. 'TXN-M6X2K1-A3F9B2C1'

    Example:
        >>> from paylode.utils import generate_ref
        >>> ref = generate_ref("ORD")
        >>> ref.startswith("ORD-")
        True
    """
    ts_part = format(int(time.time()), "X")          # hex timestamp
    rand_part = secrets.token_hex(4).upper()
    return f"{prefix}-{ts_part}-{rand_part}"


def kobo_to_naira(kobo: int) -> float:
    """
    Convert an amount from kobo to naira.

    Args:
        kobo: Amount in kobo (integer)

    Returns:
        Amount in naira as a float

    Example:
        >>> kobo_to_naira(100000)
        1000.0
        >>> kobo_to_naira(5000000)
        50000.0
    """
    if not isinstance(kobo, (int, float)):
        raise TypeError("kobo must be a number")
    return round(kobo / 100, 2)


def naira_to_kobo(naira: Union[int, float]) -> int:
    """
    Convert an amount from naira to kobo.

    Args:
        naira: Amount in naira

    Returns:
        Amount in kobo as an integer

    Example:
        >>> naira_to_kobo(1000)
        100000
        >>> naira_to_kobo(50000.50)
        5000050
    """
    if not isinstance(naira, (int, float)):
        raise TypeError("naira must be a number")
    return int(round(naira * 100))


def verify_webhook_signature(raw_body: Union[str, bytes], signature: str, secret: str) -> bool:
    """
    Verify a webhook signature from Paylode using HMAC-SHA512.

    Call this at the top of every webhook handler before processing the event.

    Args:
        raw_body:  The raw request body as string or bytes (before JSON parsing)
        signature: The value of the X-Paylode-Signature request header
        secret:    Your webhook secret from the Paylode merchant dashboard

    Returns:
        True if signature is valid, False otherwise

    Example (Django):
        raw = request.body
        sig = request.META.get('HTTP_X_PAYLODE_SIGNATURE', '')
        if not verify_webhook_signature(raw, sig, settings.PAYLODE_WEBHOOK_SECRET):
            return HttpResponse(status=401)

    Example (Flask):
        raw = request.get_data()
        sig = request.headers.get('X-Paylode-Signature', '')
        if not verify_webhook_signature(raw, sig, current_app.config['PAYLODE_WEBHOOK_SECRET']):
            abort(401)
    """
    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")
    if isinstance(secret, str):
        secret = secret.encode("utf-8")

    expected = hmac.new(secret, raw_body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(expected, signature)
