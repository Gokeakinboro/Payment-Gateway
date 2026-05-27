"""
Paylode Python SDK — Main Client
"""

from typing import Optional

from .constants import KYC_LIMITS, SDK_VERSION
from .exceptions import PaylodeError
from .http import BaseClient
from .resources import Customers, Settlements, Subaccounts, Transactions
from .utils import generate_ref, kobo_to_naira, naira_to_kobo, verify_webhook_signature


class Paylode:
    """
    Official Python SDK for Paylode Services Limited.
    CBN Licensed Payment Solution Service Provider (PSSP).

    Usage:
        from paylode import Paylode

        client = Paylode("sk_live_xxxxxxxxxxxxxxxxxxxx")

        # Initialize a payment
        txn = client.transaction.initialize(
            email="customer@example.com",
            amount=500_000,   # ₦5,000 in kobo
            channels=["card", "bank_transfer"],
            metadata={"order_id": "ORD-9812"},
        )
        redirect_url = txn["data"]["authorization_url"]

        # Verify server-side before fulfilling
        result = client.transaction.verify("TXN-20250526-001")
        if result["data"]["status"] == "success":
            fulfill_order()

    Args:
        secret_key: Your Paylode secret key (sk_live_... or sk_test_...)
        sandbox:    Force sandbox mode (auto-detected from key prefix)

    Attributes:
        transaction:  Transactions resource
        customer:     Customers resource
        subaccount:   Subaccounts resource (aggregator model)
        settlement:   Settlements resource
        version:      SDK version string
        sandbox:      True if running in test/sandbox mode
        kyc_limits:   Dict of KYC tier transaction limits
    """

    def __init__(self, secret_key: str, *, sandbox: Optional[bool] = None):
        if not secret_key:
            raise PaylodeError(
                "Secret key is required. Pass your sk_live_... or sk_test_... key.",
                code="MISSING_KEY",
                status_code=0,
            )
        if not (secret_key.startswith("sk_live_") or secret_key.startswith("sk_test_")):
            raise PaylodeError(
                "Invalid key format. Secret key must start with 'sk_live_' or 'sk_test_'.",
                code="INVALID_KEY",
                status_code=0,
            )

        self._secret_key = secret_key
        self._http = BaseClient(secret_key)

        # Auto-detect sandbox from key prefix, allow override
        self.sandbox: bool = sandbox if sandbox is not None else secret_key.startswith("sk_test_")

        # API resources
        self.transaction = Transactions(self._http)
        self.customer    = Customers(self._http)
        self.subaccount  = Subaccounts(self._http)
        self.settlement  = Settlements(self._http)

    @property
    def version(self) -> str:
        """SDK version string."""
        return SDK_VERSION

    @property
    def kyc_limits(self) -> dict:
        """KYC tier transaction limits (amounts in kobo)."""
        return KYC_LIMITS

    # ── Static helpers — no instance needed ────────────────────────────
    @staticmethod
    def verify_webhook(raw_body, signature: str, secret: str) -> bool:
        """
        Verify a webhook signature from Paylode.

        Args:
            raw_body:  Raw request body as str or bytes (before json.loads)
            signature: Value of X-Paylode-Signature header
            secret:    Your webhook secret from the merchant dashboard

        Returns:
            True if valid, False if tampered or invalid

        Django example:
            if not Paylode.verify_webhook(
                request.body,
                request.META.get("HTTP_X_PAYLODE_SIGNATURE", ""),
                settings.PAYLODE_WEBHOOK_SECRET,
            ):
                return HttpResponse(status=401)

        Flask example:
            if not Paylode.verify_webhook(
                request.get_data(),
                request.headers.get("X-Paylode-Signature", ""),
                current_app.config["PAYLODE_WEBHOOK_SECRET"],
            ):
                abort(401)
        """
        return verify_webhook_signature(raw_body, signature, secret)

    @staticmethod
    def generate_ref(prefix: str = "TXN") -> str:
        """
        Generate a unique transaction reference.

        Args:
            prefix: Prefix string (default 'TXN')

        Returns:
            Unique reference string e.g. 'TXN-M6X2K1-A3F9B2C1'
        """
        return generate_ref(prefix)

    @staticmethod
    def kobo_to_naira(kobo: int) -> float:
        """Convert kobo to naira. e.g. kobo_to_naira(100_000) → 1000.0"""
        return kobo_to_naira(kobo)

    @staticmethod
    def naira_to_kobo(naira) -> int:
        """Convert naira to kobo. e.g. naira_to_kobo(1000) → 100_000"""
        return naira_to_kobo(naira)

    def __repr__(self):
        mode = "sandbox" if self.sandbox else "live"
        return f"Paylode(mode={mode!r}, version={self.version!r})"
