"""
Paylode Python SDK — API Resources
"""

from typing import Any, Dict, List, Optional, Union
from urllib.parse import urlencode

from .http import BaseClient
from .exceptions import PaylodeValidationError
from .constants import MIN_AMOUNT_KOBO
from .utils import generate_ref


class Transactions:
    """
    Transactions resource — initialize, verify, list, fetch, refund.

    Usage:
        client = Paylode("sk_live_...")
        txn = client.transaction.initialize(
            email="customer@example.com",
            amount=500_000,   # ₦5,000 in kobo
        )
        print(txn["data"]["authorization_url"])
    """

    def __init__(self, http: BaseClient):
        self._http = http

    def initialize(
        self,
        *,
        email: str,
        amount: int,
        reference: Optional[str] = None,
        currency: str = "NGN",
        callback_url: Optional[str] = None,
        channels: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Initialize a new payment transaction.

        Args:
            email:        Customer email address (required)
            amount:       Amount in kobo — minimum ₦100 = 10,000 kobo (required)
            reference:    Unique transaction reference (auto-generated if omitted)
            currency:     Currency code, default 'NGN'
            callback_url: URL to redirect customer after payment
            channels:     Allowed payment channels e.g. ['card', 'bank_transfer', 'ussd']
            metadata:     Arbitrary key-value pairs passed through to your webhook

        Returns:
            API response dict with authorization_url, access_code, reference

        Raises:
            PaylodeValidationError: If required fields are missing or invalid
            PaylodeAPIError:        If the API returns an error

        Example:
            txn = client.transaction.initialize(
                email="customer@example.com",
                amount=500_000,
                channels=["card", "bank_transfer"],
                metadata={"order_id": "ORD-9812", "customer_name": "Ada Obi"},
            )
            redirect_url = txn["data"]["authorization_url"]
        """
        if not email or not isinstance(email, str):
            raise PaylodeValidationError("email is required and must be a string", field="email")
        if not amount:
            raise PaylodeValidationError("amount is required", field="amount")
        if not isinstance(amount, int) or amount < MIN_AMOUNT_KOBO:
            raise PaylodeValidationError(
                f"amount must be an integer in kobo, minimum ₦100 ({MIN_AMOUNT_KOBO} kobo)",
                field="amount",
            )

        body: Dict[str, Any] = {
            "email": email,
            "amount": amount,
            "currency": currency,
            "reference": reference or generate_ref(),
        }
        if callback_url:
            body["callback_url"] = callback_url
        if channels:
            body["channels"] = channels
        if metadata:
            body["metadata"] = metadata

        return self._http._request("POST", "transaction/initialize", body)

    def verify(self, reference: str) -> Dict[str, Any]:
        """
        Verify a transaction by its reference.

        IMPORTANT: Always verify server-side before fulfilling any order.
        Never trust a client-side callback alone.

        Args:
            reference: The transaction reference to verify

        Returns:
            API response dict with full transaction details including status and amount

        Example:
            result = client.transaction.verify("TXN-20250526-BOLT-001")
            if result["data"]["status"] == "success":
                fulfill_order(result["data"]["metadata"]["order_id"])
        """
        if not reference:
            raise PaylodeValidationError("reference is required", field="reference")
        return self._http._request("GET", f"transaction/verify/{reference}")

    def list(
        self,
        page: int = 1,
        per_page: int = 50,
        status: Optional[str] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        List transactions with optional filters.

        Args:
            page:      Page number (default 1)
            per_page:  Results per page (default 50, max 100)
            status:    Filter by status: 'success' | 'failed' | 'pending'
            from_date: ISO date string e.g. '2025-05-01'
            to_date:   ISO date string e.g. '2025-05-31'

        Returns:
            API response dict with list of transactions and pagination meta
        """
        params: Dict[str, Any] = {"page": page, "perPage": per_page}
        if status:
            params["status"] = status
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        qs = urlencode(params)
        return self._http._request("GET", f"transaction?{qs}")

    def fetch(self, transaction_id: str) -> Dict[str, Any]:
        """
        Fetch a single transaction by its ID.

        Args:
            transaction_id: The transaction ID (not reference)

        Returns:
            API response dict with full transaction object
        """
        if not transaction_id:
            raise PaylodeValidationError("transaction_id is required", field="transaction_id")
        return self._http._request("GET", f"transaction/{transaction_id}")

    def refund(
        self,
        reference: str,
        amount: Optional[int] = None,
        reason: str = "",
    ) -> Dict[str, Any]:
        """
        Initiate a refund for a successful transaction.

        Args:
            reference: Original transaction reference
            amount:    Amount to refund in kobo (omit for full refund)
            reason:    Reason for refund (recorded in audit log)

        Returns:
            API response dict confirming refund initiation

        Example:
            # Full refund
            client.transaction.refund("TXN-20250526-001")

            # Partial refund of ₦2,000
            client.transaction.refund("TXN-20250526-001", amount=200_000, reason="Item out of stock")
        """
        if not reference:
            raise PaylodeValidationError("reference is required", field="reference")
        body: Dict[str, Any] = {"reference": reference, "reason": reason}
        if amount is not None:
            if not isinstance(amount, int) or amount < 1:
                raise PaylodeValidationError("amount must be a positive integer in kobo", field="amount")
            body["amount"] = amount
        return self._http._request("POST", "refund", body)


class Customers:
    """
    Customers resource — create, fetch, list, update.

    Usage:
        customer = client.customer.create(
            email="ada@example.com",
            first_name="Ada",
            last_name="Obi",
        )
    """

    def __init__(self, http: BaseClient):
        self._http = http

    def create(
        self,
        *,
        email: str,
        first_name: str,
        last_name: str,
        phone: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a new customer record."""
        for field, val in [("email", email), ("first_name", first_name), ("last_name", last_name)]:
            if not val:
                raise PaylodeValidationError(f"{field} is required", field=field)
        body: Dict[str, Any] = {"email": email, "first_name": first_name, "last_name": last_name}
        if phone:
            body["phone"] = phone
        if metadata:
            body["metadata"] = metadata
        return self._http._request("POST", "customer", body)

    def fetch(self, email_or_code: str) -> Dict[str, Any]:
        """Fetch a customer by email or customer code."""
        if not email_or_code:
            raise PaylodeValidationError("email_or_code is required", field="email_or_code")
        return self._http._request("GET", f"customer/{email_or_code}")

    def list(self, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """List all customers."""
        qs = urlencode({"page": page, "perPage": per_page})
        return self._http._request("GET", f"customer?{qs}")

    def update(self, customer_code: str, **kwargs) -> Dict[str, Any]:
        """Update a customer record."""
        if not customer_code:
            raise PaylodeValidationError("customer_code is required", field="customer_code")
        return self._http._request("PUT", f"customer/{customer_code}", kwargs)


class Subaccounts:
    """
    Subaccounts resource — for aggregator split-payment model.

    Each merchant under an aggregator is represented as a subaccount.
    Paylode uses this to automatically split transaction revenue.

    Usage:
        sub = client.subaccount.create(
            business_name="Shoprite Nigeria",
            settlement_bank="GTB",
            account_number="0123456789",
            percentage_charge=70,  # merchant keeps 70%, aggregator earns from the rest
        )
    """

    def __init__(self, http: BaseClient):
        self._http = http

    def create(
        self,
        *,
        business_name: str,
        settlement_bank: str,
        account_number: str,
        percentage_charge: Union[int, float],
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create a subaccount for a merchant under an aggregator.

        Args:
            business_name:      Merchant's registered business name
            settlement_bank:    Bank code or name
            account_number:     10-digit NUBAN account number
            percentage_charge:  Percentage of transaction amount the merchant receives (0–100)
            description:        Optional description

        Returns:
            API response with subaccount code and details
        """
        required = {
            "business_name": business_name,
            "settlement_bank": settlement_bank,
            "account_number": account_number,
        }
        for field, val in required.items():
            if not val:
                raise PaylodeValidationError(f"{field} is required", field=field)
        if percentage_charge is None:
            raise PaylodeValidationError("percentage_charge is required", field="percentage_charge")
        if not (0 <= float(percentage_charge) <= 100):
            raise PaylodeValidationError(
                "percentage_charge must be between 0 and 100", field="percentage_charge"
            )
        body: Dict[str, Any] = {
            "business_name": business_name,
            "settlement_bank": settlement_bank,
            "account_number": account_number,
            "percentage_charge": float(percentage_charge),
        }
        if description:
            body["description"] = description
        return self._http._request("POST", "subaccount", body)

    def fetch(self, subaccount_code: str) -> Dict[str, Any]:
        """Fetch a subaccount by its code."""
        if not subaccount_code:
            raise PaylodeValidationError("subaccount_code is required", field="subaccount_code")
        return self._http._request("GET", f"subaccount/{subaccount_code}")

    def list(self, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """List all subaccounts."""
        qs = urlencode({"page": page, "perPage": per_page})
        return self._http._request("GET", f"subaccount?{qs}")

    def update(self, subaccount_code: str, **kwargs) -> Dict[str, Any]:
        """Update a subaccount — e.g. change settlement bank or percentage_charge."""
        if not subaccount_code:
            raise PaylodeValidationError("subaccount_code is required", field="subaccount_code")
        return self._http._request("PUT", f"subaccount/{subaccount_code}", kwargs)


class Settlements:
    """
    Settlements resource — view disbursement history.

    Usage:
        settlements = client.settlement.list(from_date="2025-05-01")
    """

    def __init__(self, http: BaseClient):
        self._http = http

    def list(
        self,
        page: int = 1,
        per_page: int = 50,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List settlements."""
        params: Dict[str, Any] = {"page": page, "perPage": per_page}
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        qs = urlencode(params)
        return self._http._request("GET", f"settlement?{qs}")

    def fetch(self, settlement_id: str) -> Dict[str, Any]:
        """Fetch a single settlement by ID."""
        if not settlement_id:
            raise PaylodeValidationError("settlement_id is required", field="settlement_id")
        return self._http._request("GET", f"settlement/{settlement_id}")
