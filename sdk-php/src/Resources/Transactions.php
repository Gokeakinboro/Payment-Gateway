<?php

declare(strict_types=1);

namespace Paylode\Resources;

use Paylode\Exceptions\PaylodeValidationException;
use Paylode\Http\Client;
use Paylode\Util\Helpers;

class Transactions
{
    private const MIN_AMOUNT_KOBO = 10_000; // ₦100

    public function __construct(private readonly Client $http) {}

    /**
     * Initialize a new payment transaction.
     *
     * @param array $params {
     *     @type string   $email        Customer email (required)
     *     @type int      $amount       Amount in kobo, minimum ₦100 = 10000 kobo (required)
     *     @type string   $reference    Unique transaction reference (auto-generated if omitted)
     *     @type string   $currency     Currency code, default 'NGN'
     *     @type string   $callback_url URL to redirect customer after payment
     *     @type string[] $channels     Allowed channels ['card','bank_transfer','ussd']
     *     @type array    $metadata     Arbitrary passthrough key-value pairs
     * }
     *
     * @return array API response with authorization_url, access_code, reference
     *
     * @throws PaylodeValidationException On missing or invalid parameters
     *
     * @example
     *   $txn = $client->transaction->initialize([
     *       'email'    => 'customer@example.com',
     *       'amount'   => 500000,
     *       'channels' => ['card', 'bank_transfer'],
     *       'metadata' => ['order_id' => 'ORD-9812'],
     *   ]);
     *   header('Location: ' . $txn['data']['authorization_url']);
     */
    public function initialize(array $params): array
    {
        $email  = $params['email']  ?? '';
        $amount = $params['amount'] ?? null;

        if (empty($email) || !is_string($email)) {
            throw new PaylodeValidationException('email is required and must be a string', 'email');
        }
        if ($amount === null) {
            throw new PaylodeValidationException('amount is required', 'amount');
        }
        if (!is_int($amount) || $amount < self::MIN_AMOUNT_KOBO) {
            throw new PaylodeValidationException(
                sprintf(
                    'amount must be an integer in kobo, minimum ₦100 (%d kobo)',
                    self::MIN_AMOUNT_KOBO
                ),
                'amount'
            );
        }

        $body = [
            'email'     => $email,
            'amount'    => $amount,
            'currency'  => $params['currency'] ?? 'NGN',
            'reference' => $params['reference'] ?? Helpers::generateRef(),
        ];

        if (!empty($params['callback_url'])) {
            $body['callback_url'] = $params['callback_url'];
        }
        if (!empty($params['channels'])) {
            $body['channels'] = $params['channels'];
        }
        if (!empty($params['metadata'])) {
            $body['metadata'] = $params['metadata'];
        }

        return $this->http->request('POST', 'transaction/initialize', $body);
    }

    /**
     * Verify a transaction by its reference.
     *
     * IMPORTANT: Always verify server-side before fulfilling any order.
     *
     * @param string $reference The transaction reference to verify
     *
     * @return array Full transaction details including status and amount
     *
     * @example
     *   $result = $client->transaction->verify('TXN-20250526-001');
     *   if ($result['data']['status'] === 'success') {
     *       fulfillOrder($result['data']['metadata']['order_id']);
     *   }
     */
    public function verify(string $reference): array
    {
        if (empty($reference)) {
            throw new PaylodeValidationException('reference is required', 'reference');
        }
        return $this->http->request('GET', "transaction/verify/{$reference}");
    }

    /**
     * List transactions with optional filters.
     *
     * @param int         $page      Page number (default 1)
     * @param int         $perPage   Results per page (default 50)
     * @param string|null $status    Filter: 'success' | 'failed' | 'pending'
     * @param string|null $fromDate  ISO date e.g. '2025-05-01'
     * @param string|null $toDate    ISO date e.g. '2025-05-31'
     *
     * @return array List of transactions with pagination meta
     */
    public function list(
        int $page = 1,
        int $perPage = 50,
        ?string $status = null,
        ?string $fromDate = null,
        ?string $toDate = null
    ): array {
        $params = ['page' => $page, 'perPage' => $perPage];
        if ($status !== null)   $params['status'] = $status;
        if ($fromDate !== null) $params['from']   = $fromDate;
        if ($toDate !== null)   $params['to']     = $toDate;

        return $this->http->request('GET', 'transaction?' . http_build_query($params));
    }

    /**
     * Fetch a single transaction by ID.
     *
     * @param string $transactionId The transaction ID (not reference)
     * @return array Full transaction object
     */
    public function fetch(string $transactionId): array
    {
        if (empty($transactionId)) {
            throw new PaylodeValidationException('transactionId is required', 'transactionId');
        }
        return $this->http->request('GET', "transaction/{$transactionId}");
    }

    /**
     * Initiate a refund for a successful transaction.
     *
     * @param string   $reference Original transaction reference
     * @param int|null $amount    Amount in kobo to refund (null for full refund)
     * @param string   $reason    Reason for refund (recorded in audit log)
     *
     * @return array Refund confirmation
     *
     * @example
     *   // Full refund
     *   $client->transaction->refund('TXN-20250526-001');
     *
     *   // Partial refund of ₦2,000
     *   $client->transaction->refund('TXN-20250526-001', 200000, 'Item out of stock');
     */
    public function refund(string $reference, ?int $amount = null, string $reason = ''): array
    {
        if (empty($reference)) {
            throw new PaylodeValidationException('reference is required', 'reference');
        }
        if ($amount !== null && $amount < 1) {
            throw new PaylodeValidationException(
                'amount must be a positive integer in kobo',
                'amount'
            );
        }

        $body = ['reference' => $reference, 'reason' => $reason];
        if ($amount !== null) {
            $body['amount'] = $amount;
        }

        return $this->http->request('POST', 'refund', $body);
    }
}
