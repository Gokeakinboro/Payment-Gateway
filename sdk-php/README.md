# paylode-php

Official PHP SDK for [Paylode Services Limited](https://paylodeservices.com) — CBN Licensed PSSP.

## Install

```bash
composer require paylode/paylode-php
```

Requires PHP 7.4+, ext-curl, ext-json.

## Quick start

```php
use Paylode\Paylode;

$client = new Paylode('sk_live_xxxxxxxxxxxxxxxxxxxx');

// Initialize a payment
$txn = $client->transaction->initialize([
    'email'    => 'customer@example.com',
    'amount'   => 500000,   // ₦5,000 in kobo
    'channels' => ['card', 'bank_transfer'],
    'metadata' => ['order_id' => 'ORD-9812'],
]);
header('Location: ' . $txn['data']['authorization_url']);

// Always verify server-side before fulfilling
$result = $client->transaction->verify('TXN-20250526-001');
if ($result['data']['status'] === 'success') {
    fulfillOrder($result['data']['metadata']['order_id']);
}
```

## Webhook verification

```php
use Paylode\Paylode;

// In your webhook handler
$raw = file_get_contents('php://input');
$sig = $_SERVER['HTTP_X_PAYLODE_SIGNATURE'] ?? '';

if (!Paylode::verifyWebhook($raw, $sig, getenv('PAYLODE_WEBHOOK_SECRET'))) {
    http_response_code(401);
    exit;
}

$event = json_decode($raw, true);
$type  = $event['event']; // e.g. 'payment.success'
// handle event...
```

## Sandbox / test mode

```php
// sk_test_ key auto-sets sandbox mode
$client = new Paylode('sk_test_xxxxxxxxxxxxxxxxxxxx');
var_dump($client->sandbox); // bool(true)
```

## Utilities

```php
Paylode::generateRef('ORD');        // "ORD-60A3F2-9C4E1A2B"
Paylode::koboToNaira(500_000);      // 5000.0
Paylode::nairaToKobo(5000);         // 500000
```

## KYC tier limits

```php
$limits = Paylode::KYC_LIMITS;
// $limits['tier_1']['single_txn'] = 5000000  (₦50,000)
// $limits['tier_2']['single_txn'] = 100000000 (₦1,000,000)
// $limits['tier_3']['single_txn'] = 500000000 (₦5,000,000)
```

## Error handling

```php
use Paylode\Exceptions\PaylodeValidationException;
use Paylode\Exceptions\PaylodeApiException;
use Paylode\Exceptions\PaylodeAuthException;

try {
    $txn = $client->transaction->initialize([...]);
} catch (PaylodeValidationException $e) {
    // Invalid params — $e->getField(), $e->getMessage()
} catch (PaylodeAuthException $e) {
    // Invalid API key
} catch (PaylodeApiException $e) {
    // API returned error — $e->getErrorCode(), $e->getStatusCode()
}
```

## Running tests

```bash
php tests/PaylodeTest.php
# or with PHPUnit:
vendor/bin/phpunit tests/
```

---
Paylode Services Limited · CBN/PAY/2024/001847 · [docs.paylodeservices.com](https://docs.paylodeservices.com)
