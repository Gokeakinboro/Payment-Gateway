<?php

/**
 * Paylode PHP SDK
 * Official server-side SDK for Paylode Services Limited
 * CBN Licensed PSSP — paylodeservices.com
 * Version: 1.0.0
 *
 * Requirements: PHP 7.4+, ext-curl, ext-json
 *
 * Installation:
 *   composer require paylode/paylode-php
 *
 * Usage:
 *   use Paylode\Paylode;
 *
 *   $client = new Paylode('sk_live_xxxxxxxxxxxx');
 *
 *   $txn = $client->transaction->initialize([
 *       'email'    => 'customer@example.com',
 *       'amount'   => 500000,   // kobo — ₦5,000
 *       'channels' => ['card', 'bank_transfer'],
 *       'metadata' => ['order_id' => 'ORD-9812'],
 *   ]);
 *   header('Location: ' . $txn['data']['authorization_url']);
 */

declare(strict_types=1);

namespace Paylode;

use Paylode\Resources\Customers;
use Paylode\Resources\Settlements;
use Paylode\Resources\Subaccounts;
use Paylode\Resources\Transactions;
use Paylode\Exceptions\PaylodeException;
use Paylode\Http\Client;
use Paylode\Util\Helpers;

class Paylode
{
    public const VERSION = '1.0.0';

    public const KYC_LIMITS = [
        'tier_1' => [
            'single_txn' => 5_000_000,       // ₦50,000 in kobo
            'daily'      => 30_000_000,       // ₦300,000
            'monthly'    => 100_000_000,      // ₦1,000,000
            'channels'   => ['card', 'ussd'],
        ],
        'tier_2' => [
            'single_txn' => 100_000_000,      // ₦1,000,000
            'daily'      => 1_000_000_000,    // ₦10,000,000
            'monthly'    => 5_000_000_000,    // ₦50,000,000
            'channels'   => ['card', 'bank_transfer', 'ussd'],
        ],
        'tier_3' => [
            'single_txn' => 500_000_000,      // ₦5,000,000
            'daily'      => 10_000_000_000,   // ₦100,000,000
            'monthly'    => null,             // custom
            'channels'   => ['card', 'bank_transfer', 'ussd', 'direct_debit'],
        ],
    ];

    /** @var Transactions */
    public Transactions $transaction;

    /** @var Customers */
    public Customers $customer;

    /** @var Subaccounts */
    public Subaccounts $subaccount;

    /** @var Settlements */
    public Settlements $settlement;

    /** @var bool */
    public bool $sandbox;

    /** @var Client */
    private Client $http;

    /**
     * @param string    $secretKey  Your sk_live_... or sk_test_... key
     * @param bool|null $sandbox    Force sandbox mode (auto-detected from key prefix)
     *
     * @throws PaylodeException
     */
    public function __construct(string $secretKey, ?bool $sandbox = null)
    {
        if (empty($secretKey)) {
            throw new PaylodeException(
                'Secret key is required. Pass your sk_live_... or sk_test_... key.',
                'MISSING_KEY',
                0
            );
        }

        if (!str_starts_with($secretKey, 'sk_live_') && !str_starts_with($secretKey, 'sk_test_')) {
            throw new PaylodeException(
                "Invalid key format. Secret key must start with 'sk_live_' or 'sk_test_'.",
                'INVALID_KEY',
                0
            );
        }

        $this->sandbox    = $sandbox ?? str_starts_with($secretKey, 'sk_test_');
        $this->http       = new Client($secretKey);
        $this->transaction = new Transactions($this->http);
        $this->customer    = new Customers($this->http);
        $this->subaccount  = new Subaccounts($this->http);
        $this->settlement  = new Settlements($this->http);
    }

    /**
     * Verify a webhook signature from Paylode.
     *
     * Call at the top of every webhook handler before processing the event.
     *
     * @param string $rawBody   Raw request body (before json_decode)
     * @param string $signature Value of X-Paylode-Signature header
     * @param string $secret    Your webhook secret from the merchant dashboard
     *
     * @return bool True if signature is valid
     *
     * @example
     *   $raw = file_get_contents('php://input');
     *   $sig = $_SERVER['HTTP_X_PAYLODE_SIGNATURE'] ?? '';
     *   if (!Paylode::verifyWebhook($raw, $sig, getenv('PAYLODE_WEBHOOK_SECRET'))) {
     *       http_response_code(401);
     *       exit;
     *   }
     *   $event = json_decode($raw, true);
     */
    public static function verifyWebhook(string $rawBody, string $signature, string $secret): bool
    {
        return Helpers::verifyWebhookSignature($rawBody, $signature, $secret);
    }

    /**
     * Generate a unique transaction reference.
     *
     * @param string $prefix Prefix string (default 'TXN')
     * @return string e.g. 'TXN-60A3F2B1-9C4E1A2B'
     */
    public static function generateRef(string $prefix = 'TXN'): string
    {
        return Helpers::generateRef($prefix);
    }

    /**
     * Convert kobo to naira.
     *
     * @param int $kobo Amount in kobo
     * @return float Amount in naira
     */
    public static function koboToNaira(int $kobo): float
    {
        return Helpers::koboToNaira($kobo);
    }

    /**
     * Convert naira to kobo.
     *
     * @param float|int $naira Amount in naira
     * @return int Amount in kobo
     */
    public static function nairaToKobo(float|int $naira): int
    {
        return Helpers::nairaToKobo($naira);
    }

    public function getVersion(): string
    {
        return self::VERSION;
    }

    public function getKycLimits(): array
    {
        return self::KYC_LIMITS;
    }

    public function __toString(): string
    {
        $mode = $this->sandbox ? 'sandbox' : 'live';
        return "Paylode(mode={$mode}, version=" . self::VERSION . ")";
    }
}
