# paylode-python

Official Python SDK for [Paylode Services Limited](https://paylodeservices.com) — CBN Licensed PSSP.

## Install

```bash
pip install paylode-python
```

Zero external dependencies — uses Python stdlib only. Requires Python 3.7+.

## Quick start

```python
from paylode import Paylode

client = Paylode("sk_live_xxxxxxxxxxxxxxxxxxxx")

# Initialize a payment
txn = client.transaction.initialize(
    email="customer@example.com",
    amount=500_000,          # ₦5,000 in kobo
    channels=["card", "bank_transfer"],
    metadata={"order_id": "ORD-9812"},
)
redirect_url = txn["data"]["authorization_url"]

# Always verify server-side before fulfilling
result = client.transaction.verify("TXN-20250526-001")
if result["data"]["status"] == "success":
    fulfill_order(result["data"]["metadata"]["order_id"])
```

## Webhook verification

```python
# Django
from paylode import Paylode

def webhook(request):
    sig = request.META.get("HTTP_X_PAYLODE_SIGNATURE", "")
    if not Paylode.verify_webhook(request.body, sig, settings.PAYLODE_WEBHOOK_SECRET):
        return HttpResponse(status=401)
    event = json.loads(request.body)
    # handle event...

# Flask
from paylode import Paylode

@app.route("/webhook", methods=["POST"])
def webhook():
    sig = request.headers.get("X-Paylode-Signature", "")
    if not Paylode.verify_webhook(request.get_data(), sig, app.config["PAYLODE_WEBHOOK_SECRET"]):
        abort(401)
    event = request.get_json()
    # handle event...
```

## Sandbox / test mode

```python
# Use sk_test_... key — sandbox auto-detected
client = Paylode("sk_test_xxxxxxxxxxxxxxxxxxxx")
print(client.sandbox)  # True
```

## Utilities

```python
Paylode.generate_ref("ORD")      # "ORD-M6X2K1-A3F9B2C1"
Paylode.kobo_to_naira(500_000)   # 5000.0
Paylode.naira_to_kobo(5000)      # 500000
```

## Running tests

```bash
python tests/test_paylode.py
# or
python -m pytest tests/ -v
```

---
Paylode Services Limited · CBN/PAY/2024/001847 · [docs.paylodeservices.com](https://docs.paylodeservices.com)
