"""
Paylode Python SDK — Test Suite
Run: python -m pytest tests/ -v
  or: python tests/test_paylode.py
No external dependencies required.
"""

import hashlib
import hmac
import json
import sys
import os
import unittest

# Add parent dir to path for direct execution
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from paylode import Paylode, KYC_LIMITS
from paylode.exceptions import (
    PaylodeError,
    PaylodeValidationError,
    PaylodeAuthError,
)
from paylode.utils import generate_ref, kobo_to_naira, naira_to_kobo, verify_webhook_signature


class TestInstantiation(unittest.TestCase):

    def test_accepts_live_key(self):
        client = Paylode("sk_live_testxxxxxxxxxxxxxxxx")
        self.assertFalse(client.sandbox)

    def test_accepts_test_key_sets_sandbox(self):
        client = Paylode("sk_test_testxxxxxxxxxxxxxxxx")
        self.assertTrue(client.sandbox)

    def test_sandbox_override(self):
        client = Paylode("sk_live_xxx", sandbox=True)
        self.assertTrue(client.sandbox)

    def test_raises_on_missing_key(self):
        with self.assertRaises(PaylodeError) as ctx:
            Paylode("")
        self.assertEqual(ctx.exception.code, "MISSING_KEY")

    def test_raises_on_none_key(self):
        with self.assertRaises(PaylodeError):
            Paylode(None)

    def test_raises_on_invalid_key_format(self):
        with self.assertRaises(PaylodeError) as ctx:
            Paylode("pk_live_wrongkey")
        self.assertEqual(ctx.exception.code, "INVALID_KEY")

    def test_raises_on_public_key(self):
        with self.assertRaises(PaylodeError) as ctx:
            Paylode("pk_test_something")
        self.assertEqual(ctx.exception.code, "INVALID_KEY")

    def test_version_exposed(self):
        client = Paylode("sk_test_x")
        self.assertIsInstance(client.version, str)
        self.assertGreater(len(client.version), 0)

    def test_repr(self):
        client = Paylode("sk_test_x")
        self.assertIn("sandbox", repr(client))

    def test_kyc_limits_exposed(self):
        client = Paylode("sk_test_x")
        self.assertIn("tier_1", client.kyc_limits)
        self.assertIn("tier_2", client.kyc_limits)
        self.assertIn("tier_3", client.kyc_limits)
        self.assertEqual(client.kyc_limits["tier_1"]["single_txn"], 5_000_000)
        self.assertEqual(client.kyc_limits["tier_2"]["single_txn"], 100_000_000)
        self.assertEqual(client.kyc_limits["tier_3"]["single_txn"], 500_000_000)

    def test_resources_attached(self):
        client = Paylode("sk_test_x")
        self.assertTrue(hasattr(client, "transaction"))
        self.assertTrue(hasattr(client, "customer"))
        self.assertTrue(hasattr(client, "subaccount"))
        self.assertTrue(hasattr(client, "settlement"))


class TestTransactionValidation(unittest.TestCase):
    """Validation tests — no network calls made."""

    def setUp(self):
        self.client = Paylode("sk_test_xxxxxxxxxxxxxxxx")

    def _run(self, coro):
        """Helper — catch exceptions from async-like calls."""
        try:
            coro
        except Exception as e:
            raise e

    def test_missing_email_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.transaction.initialize(email="", amount=100_000)
        self.assertEqual(ctx.exception.field, "email")

    def test_missing_amount_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.transaction.initialize(email="a@b.com", amount=0)
        self.assertEqual(ctx.exception.field, "amount")

    def test_amount_below_minimum_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.transaction.initialize(email="a@b.com", amount=5_000)
        self.assertIn("minimum", str(ctx.exception).lower())

    def test_amount_as_float_raises(self):
        with self.assertRaises(PaylodeValidationError):
            self.client.transaction.initialize(email="a@b.com", amount=10000.50)

    def test_verify_missing_reference_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.transaction.verify("")
        self.assertEqual(ctx.exception.field, "reference")

    def test_verify_none_reference_raises(self):
        with self.assertRaises(PaylodeValidationError):
            self.client.transaction.verify(None)

    def test_refund_missing_reference_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.transaction.refund("")
        self.assertEqual(ctx.exception.field, "reference")

    def test_refund_invalid_amount_raises(self):
        with self.assertRaises(PaylodeValidationError):
            self.client.transaction.refund("TXN-001", amount=-500)


class TestCustomerValidation(unittest.TestCase):

    def setUp(self):
        self.client = Paylode("sk_test_x")

    def test_missing_email_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.customer.create(email="", first_name="Ada", last_name="Obi")
        self.assertEqual(ctx.exception.field, "email")

    def test_missing_first_name_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.customer.create(email="a@b.com", first_name="", last_name="Obi")
        self.assertEqual(ctx.exception.field, "first_name")

    def test_missing_last_name_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.customer.create(email="a@b.com", first_name="Ada", last_name="")
        self.assertEqual(ctx.exception.field, "last_name")

    def test_fetch_missing_code_raises(self):
        with self.assertRaises(PaylodeValidationError):
            self.client.customer.fetch("")


class TestSubaccountValidation(unittest.TestCase):

    def setUp(self):
        self.client = Paylode("sk_test_x")

    def test_missing_business_name_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.subaccount.create(
                business_name="",
                settlement_bank="GTB",
                account_number="0123456789",
                percentage_charge=70,
            )
        self.assertEqual(ctx.exception.field, "business_name")

    def test_invalid_percentage_over_100_raises(self):
        with self.assertRaises(PaylodeValidationError) as ctx:
            self.client.subaccount.create(
                business_name="Test Co",
                settlement_bank="GTB",
                account_number="0123456789",
                percentage_charge=110,
            )
        self.assertEqual(ctx.exception.field, "percentage_charge")

    def test_invalid_percentage_negative_raises(self):
        with self.assertRaises(PaylodeValidationError):
            self.client.subaccount.create(
                business_name="Test Co",
                settlement_bank="GTB",
                account_number="0123456789",
                percentage_charge=-10,
            )

    def test_valid_percentage_zero(self):
        """0% is valid — merchant receives nothing (full aggregator split)."""
        # Should only fail at network level, not validation
        try:
            self.client.subaccount.create(
                business_name="Test Co",
                settlement_bank="GTB",
                account_number="0123456789",
                percentage_charge=0,
            )
        except PaylodeValidationError:
            self.fail("percentage_charge=0 should not raise PaylodeValidationError")
        except Exception:
            pass  # network errors expected in test


class TestWebhookVerification(unittest.TestCase):

    def _make_sig(self, body: str, secret: str) -> str:
        return hmac.new(
            secret.encode("utf-8"),
            body.encode("utf-8"),
            hashlib.sha512,
        ).hexdigest()

    def test_valid_signature_returns_true(self):
        secret = "whsec_paylode_test_secret_xyz"
        body = json.dumps({"event": "payment.success", "data": {"reference": "TXN-001"}})
        sig = self._make_sig(body, secret)
        self.assertTrue(Paylode.verify_webhook(body, sig, secret))

    def test_invalid_signature_returns_false(self):
        self.assertFalse(Paylode.verify_webhook("body", "badsignature", "secret"))

    def test_tampered_body_returns_false(self):
        secret = "test_secret"
        original = json.dumps({"amount": 100_000})
        sig = self._make_sig(original, secret)
        tampered = json.dumps({"amount": 999_999})
        self.assertFalse(Paylode.verify_webhook(tampered, sig, secret))

    def test_bytes_body_works(self):
        secret = "test_secret"
        body = b'{"event":"payment.success"}'
        sig = hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()
        self.assertTrue(Paylode.verify_webhook(body, sig, secret))

    def test_static_util_matches_instance_method(self):
        secret = "secret123"
        body = "test body"
        sig = self._make_sig(body, secret)
        client = Paylode("sk_test_x")
        self.assertEqual(
            client.verify_webhook(body, sig, secret),
            verify_webhook_signature(body, sig, secret),
        )


class TestUtils(unittest.TestCase):

    def test_generate_ref_default_prefix(self):
        ref = generate_ref()
        self.assertTrue(ref.startswith("TXN-"))
        self.assertGreater(len(ref), 8)

    def test_generate_ref_custom_prefix(self):
        ref = generate_ref("ORD")
        self.assertTrue(ref.startswith("ORD-"))

    def test_generate_ref_uniqueness(self):
        import time
        refs = set()
        for _ in range(200):
            refs.add(generate_ref())
            time.sleep(0)
        self.assertEqual(len(refs), 200)

    def test_kobo_to_naira(self):
        self.assertEqual(kobo_to_naira(100_000), 1000.0)
        self.assertEqual(kobo_to_naira(5_000_000), 50_000.0)
        self.assertEqual(kobo_to_naira(1), 0.01)
        self.assertEqual(kobo_to_naira(150), 1.5)

    def test_naira_to_kobo(self):
        self.assertEqual(naira_to_kobo(1000), 100_000)
        self.assertEqual(naira_to_kobo(50_000), 5_000_000)
        self.assertEqual(naira_to_kobo(0.01), 1)

    def test_kobo_naira_roundtrip(self):
        original = 750_000
        self.assertEqual(naira_to_kobo(kobo_to_naira(original)), original)

    def test_kobo_to_naira_type_error(self):
        with self.assertRaises(TypeError):
            kobo_to_naira("100000")

    def test_naira_to_kobo_type_error(self):
        with self.assertRaises(TypeError):
            naira_to_kobo("1000")

    def test_static_helpers_on_class(self):
        self.assertEqual(Paylode.kobo_to_naira(100_000), 1000.0)
        self.assertEqual(Paylode.naira_to_kobo(1000), 100_000)
        self.assertTrue(Paylode.generate_ref().startswith("TXN-"))


class TestKYCConstants(unittest.TestCase):

    def test_all_tiers_present(self):
        for tier in ["tier_1", "tier_2", "tier_3"]:
            self.assertIn(tier, KYC_LIMITS)

    def test_tier_limits_correct(self):
        self.assertEqual(KYC_LIMITS["tier_1"]["single_txn"],  5_000_000)
        self.assertEqual(KYC_LIMITS["tier_1"]["daily"],       30_000_000)
        self.assertEqual(KYC_LIMITS["tier_1"]["monthly"],     100_000_000)
        self.assertEqual(KYC_LIMITS["tier_2"]["single_txn"],  100_000_000)
        self.assertEqual(KYC_LIMITS["tier_2"]["daily"],       1_000_000_000)
        self.assertEqual(KYC_LIMITS["tier_3"]["single_txn"],  500_000_000)
        self.assertIsNone(KYC_LIMITS["tier_3"]["monthly"])    # custom

    def test_channels_defined(self):
        self.assertIn("card",          KYC_LIMITS["tier_1"]["channels"])
        self.assertIn("bank_transfer", KYC_LIMITS["tier_2"]["channels"])
        self.assertIn("direct_debit",  KYC_LIMITS["tier_3"]["channels"])


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite  = unittest.TestSuite()
    for cls in [
        TestInstantiation, TestTransactionValidation, TestCustomerValidation,
        TestSubaccountValidation, TestWebhookVerification, TestUtils, TestKYCConstants,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
