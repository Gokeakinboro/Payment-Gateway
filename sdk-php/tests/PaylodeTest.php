<?php

declare(strict_types=1);

/**
 * Paylode PHP SDK — Test Suite
 *
 * Run with PHPUnit:  vendor/bin/phpunit tests/
 * Run standalone:    php tests/PaylodeTest.php
 *
 * No external dependencies needed for standalone run.
 */

// ── Autoloader (standalone mode) ────────────────────────────────────────────
if (!class_exists('Paylode\\Paylode')) {
    spl_autoload_register(function (string $class): void {
        $base = __DIR__ . '/../src/';
        $file = $base . str_replace(['Paylode\\', '\\'], ['', DIRECTORY_SEPARATOR], $class) . '.php';
        if (file_exists($file)) {
            require_once $file;
        }
    });

    // Flatten Resources.php since it holds all 3 resource classes
    require_once __DIR__ . '/../src/Resources/Resources.php';
}

use Paylode\Paylode;
use Paylode\Exceptions\PaylodeException;
use Paylode\Exceptions\PaylodeValidationException;
use Paylode\Util\Helpers;

// ── Tiny test runner (standalone) ───────────────────────────────────────────
$passed = 0;
$failed = 0;

function t(string $name, callable $fn): void
{
    global $passed, $failed;
    try {
        $fn();
        echo "  \033[32m✓\033[0m  {$name}\n";
        $passed++;
    } catch (\Throwable $e) {
        echo "  \033[31m✗\033[0m  {$name}\n    {$e->getMessage()}\n";
        $failed++;
    }
}

function assertEq(mixed $expected, mixed $actual, string $msg = ''): void
{
    if ($expected !== $actual) {
        throw new \AssertionError(
            $msg ?: "Expected " . var_export($expected, true) . ", got " . var_export($actual, true)
        );
    }
}

function assertTrue(bool $val, string $msg = ''): void
{
    if (!$val) throw new \AssertionError($msg ?: 'Expected true, got false');
}

function assertFalse(bool $val, string $msg = ''): void
{
    if ($val) throw new \AssertionError($msg ?: 'Expected false, got true');
}

function assertThrows(callable $fn, string $exceptionClass, ?string $code = null): void
{
    try {
        $fn();
        throw new \AssertionError("Expected {$exceptionClass} but none thrown");
    } catch (\Throwable $e) {
        if (!($e instanceof $exceptionClass)) {
            throw new \AssertionError(
                "Expected {$exceptionClass}, got " . get_class($e) . ": " . $e->getMessage()
            );
        }
        if ($code !== null && method_exists($e, 'getErrorCode') && $e->getErrorCode() !== $code) {
            throw new \AssertionError(
                "Expected error code {$code}, got {$e->getErrorCode()}"
            );
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
echo "\n  Paylode PHP SDK — Unit Tests\n\n";

// ── Instantiation ────────────────────────────────────────────────────────────
echo "  Instantiation\n";

t('accepts sk_live_ key', function () {
    $client = new Paylode('sk_live_testxxxxxxxxxxxxxxxx');
    assertFalse($client->sandbox);
});

t('accepts sk_test_ key and sets sandbox mode', function () {
    $client = new Paylode('sk_test_testxxxxxxxxxxxxxxxx');
    assertTrue($client->sandbox);
});

t('sandbox override works', function () {
    $client = new Paylode('sk_live_xxx', true);
    assertTrue($client->sandbox);
});

t('throws on empty key', function () {
    assertThrows(fn () => new Paylode(''), PaylodeException::class, 'MISSING_KEY');
});

t('throws on invalid key format (pk_ prefix)', function () {
    assertThrows(fn () => new Paylode('pk_live_wrongkey'), PaylodeException::class, 'INVALID_KEY');
});

t('throws on plain string key', function () {
    assertThrows(fn () => new Paylode('not_a_key'), PaylodeException::class, 'INVALID_KEY');
});

t('exposes version string', function () {
    $client = new Paylode('sk_test_x');
    assertTrue(strlen($client->getVersion()) > 0);
    assertEq(Paylode::VERSION, $client->getVersion());
});

t('exposes kyc_limits with all tiers', function () {
    $limits = Paylode::KYC_LIMITS;
    assertTrue(isset($limits['tier_1']));
    assertTrue(isset($limits['tier_2']));
    assertTrue(isset($limits['tier_3']));
    assertEq(5_000_000, $limits['tier_1']['single_txn']);
    assertEq(100_000_000, $limits['tier_2']['single_txn']);
    assertEq(500_000_000, $limits['tier_3']['single_txn']);
    assertEq(null, $limits['tier_3']['monthly']);
});

t('resources are attached', function () {
    $client = new Paylode('sk_test_x');
    assertTrue(isset($client->transaction));
    assertTrue(isset($client->customer));
    assertTrue(isset($client->subaccount));
    assertTrue(isset($client->settlement));
});

t('__toString includes mode', function () {
    $client = new Paylode('sk_test_x');
    assertTrue(str_contains((string)$client, 'sandbox'));
});

// ── Transaction validation ───────────────────────────────────────────────────
echo "\n  Transaction validation\n";

t('throws on missing email', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->transaction->initialize(['email' => '', 'amount' => 100_000]),
        PaylodeValidationException::class
    );
});

t('throws on missing amount', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->transaction->initialize(['email' => 'a@b.com']),
        PaylodeValidationException::class
    );
});

t('throws on amount below minimum', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->transaction->initialize(['email' => 'a@b.com', 'amount' => 5_000]),
        PaylodeValidationException::class
    );
});

t('throws on float amount', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->transaction->initialize(['email' => 'a@b.com', 'amount' => 10000.5]),
        PaylodeValidationException::class
    );
});

t('throws on verify with empty reference', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(fn () => $client->transaction->verify(''), PaylodeValidationException::class);
});

t('throws on refund with empty reference', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(fn () => $client->transaction->refund(''), PaylodeValidationException::class);
});

t('throws on refund with negative amount', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->transaction->refund('TXN-001', -500),
        PaylodeValidationException::class
    );
});

// ── Customer validation ─────────────────────────────────────────────────────
echo "\n  Customer validation\n";

t('throws on missing email', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->customer->create(['email' => '', 'first_name' => 'Ada', 'last_name' => 'Obi']),
        PaylodeValidationException::class
    );
});

t('throws on missing first_name', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->customer->create(['email' => 'a@b.com', 'first_name' => '', 'last_name' => 'Obi']),
        PaylodeValidationException::class
    );
});

t('throws on fetch with empty code', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(fn () => $client->customer->fetch(''), PaylodeValidationException::class);
});

// ── Subaccount validation ───────────────────────────────────────────────────
echo "\n  Subaccount validation\n";

t('throws on missing business_name', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->subaccount->create([
            'business_name'     => '',
            'settlement_bank'   => 'GTB',
            'account_number'    => '0123456789',
            'percentage_charge' => 70,
        ]),
        PaylodeValidationException::class
    );
});

t('throws on percentage_charge over 100', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->subaccount->create([
            'business_name'     => 'Test Co',
            'settlement_bank'   => 'GTB',
            'account_number'    => '0123456789',
            'percentage_charge' => 110,
        ]),
        PaylodeValidationException::class
    );
});

t('throws on negative percentage_charge', function () {
    $client = new Paylode('sk_test_x');
    assertThrows(
        fn () => $client->subaccount->create([
            'business_name'     => 'Test Co',
            'settlement_bank'   => 'GTB',
            'account_number'    => '0123456789',
            'percentage_charge' => -5,
        ]),
        PaylodeValidationException::class
    );
});

t('0% percentage_charge passes validation', function () {
    $client = new Paylode('sk_test_x');
    try {
        $client->subaccount->create([
            'business_name'     => 'Test Co',
            'settlement_bank'   => 'GTB',
            'account_number'    => '0123456789',
            'percentage_charge' => 0,
        ]);
    } catch (PaylodeValidationException $e) {
        throw new \AssertionError('0% should not throw validation error');
    } catch (\Throwable $e) {
        // Network errors fine here
    }
});

// ── Webhook verification ────────────────────────────────────────────────────
echo "\n  Webhook signature verification\n";

t('valid signature returns true', function () {
    $secret = 'whsec_paylode_test_secret_xyz';
    $body   = json_encode(['event' => 'payment.success', 'data' => ['reference' => 'TXN-001']]);
    $sig    = hash_hmac('sha512', $body, $secret);
    assertTrue(Paylode::verifyWebhook($body, $sig, $secret));
});

t('invalid signature returns false', function () {
    assertFalse(Paylode::verifyWebhook('body', 'badsignature', 'secret'));
});

t('tampered body returns false', function () {
    $secret   = 'test_secret';
    $original = json_encode(['amount' => 100_000]);
    $sig      = hash_hmac('sha512', $original, $secret);
    $tampered = json_encode(['amount' => 999_999]);
    assertFalse(Paylode::verifyWebhook($tampered, $sig, $secret));
});

t('static helper matches Helpers::verifyWebhookSignature', function () {
    $secret = 'shared_secret';
    $body   = 'test-webhook-body';
    $sig    = hash_hmac('sha512', $body, $secret);
    assertEq(
        Helpers::verifyWebhookSignature($body, $sig, $secret),
        Paylode::verifyWebhook($body, $sig, $secret)
    );
});

// ── Helpers (utils) ─────────────────────────────────────────────────────────
echo "\n  Helpers\n";

t('generateRef uses TXN prefix by default', function () {
    $ref = Helpers::generateRef();
    assertTrue(str_starts_with($ref, 'TXN-'));
    assertTrue(strlen($ref) > 8);
});

t('generateRef respects custom prefix', function () {
    $ref = Helpers::generateRef('ORD');
    assertTrue(str_starts_with($ref, 'ORD-'));
});

t('generateRef produces unique values', function () {
    $refs = array_map(fn () => Helpers::generateRef(), range(1, 100));
    assertEq(100, count(array_unique($refs)));
});

t('koboToNaira converts correctly', function () {
    assertEq(1000.0,  Helpers::koboToNaira(100_000));
    assertEq(50000.0, Helpers::koboToNaira(5_000_000));
    assertEq(0.01,    Helpers::koboToNaira(1));
});

t('nairaToKobo converts correctly', function () {
    assertEq(100_000,   Helpers::nairaToKobo(1000));
    assertEq(5_000_000, Helpers::nairaToKobo(50000));
    assertEq(1,         Helpers::nairaToKobo(0.01));
});

t('kobo-naira round-trip is lossless', function () {
    $original = 750_000;
    assertEq($original, Helpers::nairaToKobo(Helpers::koboToNaira($original)));
});

t('static helpers work on Paylode class', function () {
    assertEq(1000.0,  Paylode::koboToNaira(100_000));
    assertEq(100_000, Paylode::nairaToKobo(1000));
    assertTrue(str_starts_with(Paylode::generateRef(), 'TXN-'));
});

// ── Summary ─────────────────────────────────────────────────────────────────
echo "\n  " . ($passed + $failed) . " tests: \033[32m{$passed} passed\033[0m";
if ($failed > 0) {
    echo ", \033[31m{$failed} failed\033[0m";
}
echo "\n\n";

exit($failed > 0 ? 1 : 0);
