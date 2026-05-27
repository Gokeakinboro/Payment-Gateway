<?php

declare(strict_types=1);

namespace Paylode\Util;

class Helpers
{
    /**
     * Verify a Paylode webhook signature using HMAC-SHA512.
     *
     * @param string $rawBody   Raw request body before json_decode
     * @param string $signature X-Paylode-Signature header value
     * @param string $secret    Webhook secret from dashboard
     *
     * @return bool True if signature is valid
     */
    public static function verifyWebhookSignature(
        string $rawBody,
        string $signature,
        string $secret
    ): bool {
        $expected = hash_hmac('sha512', $rawBody, $secret);
        return hash_equals($expected, $signature);
    }

    /**
     * Generate a unique transaction reference.
     *
     * @param string $prefix Prefix (default 'TXN')
     * @return string e.g. 'TXN-60A3F2-9C4E1A2B'
     */
    public static function generateRef(string $prefix = 'TXN'): string
    {
        $tsPart   = strtoupper(base_convert((string) time(), 10, 16));
        $randPart = strtoupper(bin2hex(random_bytes(4)));
        return "{$prefix}-{$tsPart}-{$randPart}";
    }

    /**
     * Convert kobo to naira.
     *
     * @param int $kobo Amount in kobo
     * @return float Amount in naira e.g. koboToNaira(100000) = 1000.0
     */
    public static function koboToNaira(int $kobo): float
    {
        return round($kobo / 100, 2);
    }

    /**
     * Convert naira to kobo.
     *
     * @param float|int $naira Amount in naira
     * @return int Amount in kobo e.g. nairaToKobo(1000) = 100000
     */
    public static function nairaToKobo(float|int $naira): int
    {
        return (int) round($naira * 100);
    }
}
