"""
Paylode Python SDK — Constants
"""

SDK_VERSION = "1.0.0"
BASE_URL = "https://api.paylodeservices.com"
API_VERSION = "v1"

# KYC Tier transaction limits (amounts in kobo)
KYC_LIMITS = {
    "tier_1": {
        "single_txn": 5_000_000,       # ₦50,000
        "daily":      30_000_000,      # ₦300,000
        "monthly":    100_000_000,     # ₦1,000,000
        "channels":   ["card", "ussd"],
    },
    "tier_2": {
        "single_txn": 100_000_000,     # ₦1,000,000
        "daily":      1_000_000_000,   # ₦10,000,000
        "monthly":    5_000_000_000,   # ₦50,000,000
        "channels":   ["card", "bank_transfer", "ussd"],
    },
    "tier_3": {
        "single_txn": 500_000_000,     # ₦5,000,000
        "daily":      10_000_000_000,  # ₦100,000,000
        "monthly":    None,            # custom — negotiated with Paylode ops
        "channels":   ["card", "bank_transfer", "ussd", "direct_debit"],
    },
}

# Supported payment channels
CHANNELS = ["card", "bank_transfer", "ussd", "direct_debit"]

# Transaction statuses
TXN_STATUS_SUCCESS = "success"
TXN_STATUS_FAILED  = "failed"
TXN_STATUS_PENDING = "pending"

# Minimum transaction amount (₦100 = 10,000 kobo)
MIN_AMOUNT_KOBO = 10_000
