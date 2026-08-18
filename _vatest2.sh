#!/usr/bin/env bash
set -e
cd /opt/paylode-api/backend
DB=$(grep ^DATABASE_URL= .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
MID="1fc902f3-b5a3-4e86-a6f0-7161cd034b8b"
REF="VATEST-PX-V4-$(date +%s)"

# Set demo merchant webhook URL
psql "$DB" -q -c "UPDATE merchants SET webhook_url='https://paylodeservices.com/api/v1/webhooks/test-echo', webhook_secret='sandbox-test' WHERE id='$MID'"

# Create ₦2000 face live transaction
psql "$DB" -q -c "INSERT INTO transactions (reference,merchant_id,customer_email,amount,currency,status,channel,is_sandbox,metadata,updated_at) VALUES ('$REF','$MID','va-test@paylode.local',200000,'NGN','PENDING','BANK_TRANSFER'::\"Channel\",false,'{\"product\":\"VIRTUAL_ACCOUNT\"}'::jsonb,NOW())"
echo "txn: $REF"

# Mint VA — capture the gross amount from the response
echo "=== Minting VA ==="
MINT_JSON=$(curl -s "http://127.0.0.1:3001/api/v1/checkout/$REF/virtual-account")
echo "$MINT_JSON"

# Extract gross in kobo and convert to naira string for the inflow
GROSS_KOBO=$(echo "$MINT_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data; console.log(d.amount)")
GROSS_NAIRA=$(node -e "console.log(($GROSS_KOBO/100).toFixed(2))")
VA_NO=$(psql "$DB" -A -t -c "SELECT metadata->>'parallex_va_no' FROM transactions WHERE reference='$REF'" | tr -d ' \r\n')
echo "VA: $VA_NO | gross_naira: $GROSS_NAIRA"

# Simulate inflow with the EXACT minted gross amount
echo ""
echo "=== Simulating inflow with correct amount ₦$GROSS_NAIRA ==="
curl -s -X POST "http://127.0.0.1:3001/api/v1/webhooks/parallex/inflow" \
  -H "Content-Type: application/json" \
  -d "{\"referenceID\":\"$REF\",\"beneficiaryAccountNumber\":\"$VA_NO\",\"amount\":\"$GROSS_NAIRA\",\"status\":\"SUCCESS\",\"sessionId\":\"SESS-$(date +%s)\",\"originatingAccountNumber\":\"0123456789\",\"originatingAccountName\":\"Test Payer\",\"originatingBankName\":\"GTBank\"}"
echo

sleep 3

# Results
echo ""
echo "=== Transaction ==="
psql "$DB" -A -F'|' -c "SELECT status, amount/100.0 gross_ngn, merchant_fee/100.0 our_fee_ngn, rail_cost/100.0 rail_cost_ngn, net_revenue/100.0 net_rev_ngn FROM transactions WHERE reference='$REF'"

echo ""
echo "=== Webhook delivery ==="
psql "$DB" -A -F'|' -c "SELECT event, response_code, success, attempt FROM webhook_deliveries WHERE payload->>'reference'='$REF'"

# Cleanup
psql "$DB" -q -c "DELETE FROM webhook_deliveries WHERE payload->>'reference'='$REF'; DELETE FROM transactions WHERE reference='$REF'; UPDATE merchants SET webhook_url=NULL,webhook_secret=NULL WHERE id='$MID'"
echo "cleaned up"
