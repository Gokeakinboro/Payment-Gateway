#!/usr/bin/env bash
set -e
cd /opt/paylode-api/backend
DB=$(grep ^DATABASE_URL= .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
MID="1fc902f3-b5a3-4e86-a6f0-7161cd034b8b"
REF="VATEST-PX-V3-$(date +%s)"
WH_URL="https://webhook.paylodeservices.com/test-echo"

echo "=== 1) Set Demo merchant webhook URL ==="
psql "$DB" -q -c "UPDATE merchants SET webhook_url='$WH_URL', webhook_secret='sandbox-test' WHERE id='$MID'"
echo "set"

echo ""
echo "=== 2) Create ₦2000 live PENDING transaction ==="
psql "$DB" -q -c "INSERT INTO transactions (reference,merchant_id,customer_email,amount,currency,status,channel,is_sandbox,metadata,updated_at) VALUES ('$REF','$MID','va-test@paylode.local',200000,'NGN','PENDING','BANK_TRANSFER'::\"Channel\",false,'{\"product\":\"VIRTUAL_ACCOUNT\"}'::jsonb,NOW())"
echo "txn: $REF"

echo ""
echo "=== 3) Mint Parallex VA ==="
MINT=$(curl -s "http://127.0.0.1:3001/api/v1/checkout/$REF/virtual-account")
echo "$MINT"
VA_NO=$(psql "$DB" -A -t -c "SELECT metadata->>'parallex_va_no' FROM transactions WHERE reference='$REF'" | tr -d ' \r\n')
echo "VA: $VA_NO"

echo ""
echo "=== 4) Simulate Parallex inflow ==="
curl -s -X POST "http://127.0.0.1:3001/api/v1/webhooks/parallex/inflow" \
  -H "Content-Type: application/json" \
  -d "{\"referenceID\":\"$REF\",\"beneficiaryAccountNumber\":\"$VA_NO\",\"amount\":\"2012.90\",\"status\":\"SUCCESS\",\"sessionId\":\"SESS-$(date +%s)\",\"originatingAccountNumber\":\"0123456789\",\"originatingAccountName\":\"Test Payer\",\"originatingBankName\":\"GTBank\"}"
echo

sleep 3

echo ""
echo "=== 5) Transaction result ==="
psql "$DB" -A -F'|' -c "SELECT status, amount/100.0 gross_ngn, merchant_fee/100.0 our_fee_ngn, rail_cost/100.0 rail_cost_ngn, net_revenue/100.0 net_rev_ngn FROM transactions WHERE reference='$REF'"

echo ""
echo "=== 6) payment.success webhook delivery ==="
psql "$DB" -A -F'|' -c "SELECT event, response_code, success, attempt FROM webhook_deliveries WHERE payload->>'reference'='$REF'"

echo ""
echo "=== 7) Cleanup ==="
psql "$DB" -q -c "DELETE FROM webhook_deliveries WHERE payload->>'reference'='$REF'; DELETE FROM transactions WHERE reference='$REF'; UPDATE merchants SET webhook_url=NULL, webhook_secret=NULL WHERE id='$MID'"
echo "done"
