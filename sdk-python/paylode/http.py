"""
Paylode Python SDK — HTTP base client
"""

import json
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

from .constants import BASE_URL, API_VERSION, SDK_VERSION
from .exceptions import PaylodeError, PaylodeAuthError, PaylodeAPIError


class BaseClient:
    """
    Internal HTTP client — handles all requests to the Paylode API.
    Uses only stdlib (urllib) — zero external dependencies.
    """

    def __init__(self, secret_key: str):
        self._secret_key = secret_key
        self._base = f"{BASE_URL}/{API_VERSION}"

    def _headers(self) -> Dict[str, str]:
        import sys
        return {
            "Authorization": f"Bearer {self._secret_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Paylode-SDK": f"python/{SDK_VERSION}",
            "X-Paylode-Python": f"{sys.version_info.major}.{sys.version_info.minor}",
        }

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self._base}/{path}"
        payload = json.dumps(body).encode("utf-8") if body else None

        req = urllib.request.Request(
            url,
            data=payload,
            headers=self._headers(),
            method=method.upper(),
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)

        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {"message": raw, "error_code": "HTTP_ERROR"}

            if e.code == 401:
                raise PaylodeAuthError(
                    parsed.get("message", "Authentication failed"),
                    raw=parsed,
                )
            raise PaylodeAPIError(
                message=parsed.get("message", f"API error {e.code}"),
                code=parsed.get("error_code", "API_ERROR"),
                status_code=e.code,
                raw=parsed,
            )

        except urllib.error.URLError as e:
            raise PaylodeError(
                message=f"Network error: {e.reason}",
                code="NETWORK_ERROR",
                status_code=0,
            )
