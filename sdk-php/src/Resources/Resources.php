<?php

declare(strict_types=1);

namespace Paylode\Resources;

use Paylode\Exceptions\PaylodeValidationException;
use Paylode\Http\Client;

// ────────────────────────────────────────────────────────────────────────────
// Customers
// ────────────────────────────────────────────────────────────────────────────

class Customers
{
    public function __construct(private readonly Client $http) {}

    /**
     * Create a new customer record.
     *
     * @param array $params {
     *     @type string $email      Customer email (required)
     *     @type string $first_name First name (required)
     *     @type string $last_name  Last name (required)
     *     @type string $phone      Phone number (optional)
     *     @type array  $metadata   Key-value pairs (optional)
     * }
     */
    public function create(array $params): array
    {
        foreach (['email', 'first_name', 'last_name'] as $field) {
            if (empty($params[$field])) {
                throw new PaylodeValidationException("{$field} is required", $field);
            }
        }

        $body = [
            'email'      => $params['email'],
            'first_name' => $params['first_name'],
            'last_name'  => $params['last_name'],
        ];
        if (!empty($params['phone']))    $body['phone']    = $params['phone'];
        if (!empty($params['metadata'])) $body['metadata'] = $params['metadata'];

        return $this->http->request('POST', 'customer', $body);
    }

    /**
     * Fetch a customer by email or customer code.
     *
     * @param string $emailOrCode
     */
    public function fetch(string $emailOrCode): array
    {
        if (empty($emailOrCode)) {
            throw new PaylodeValidationException('emailOrCode is required', 'emailOrCode');
        }
        return $this->http->request('GET', "customer/{$emailOrCode}");
    }

    /**
     * List all customers.
     */
    public function list(int $page = 1, int $perPage = 50): array
    {
        $qs = http_build_query(['page' => $page, 'perPage' => $perPage]);
        return $this->http->request('GET', "customer?{$qs}");
    }

    /**
     * Update a customer record.
     *
     * @param string $customerCode Customer code from Paylode
     * @param array  $params       Fields to update
     */
    public function update(string $customerCode, array $params): array
    {
        if (empty($customerCode)) {
            throw new PaylodeValidationException('customerCode is required', 'customerCode');
        }
        return $this->http->request('PUT', "customer/{$customerCode}", $params);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Subaccounts  (aggregator model)
// ────────────────────────────────────────────────────────────────────────────

class Subaccounts
{
    public function __construct(private readonly Client $http) {}

    /**
     * Create a subaccount for a merchant under an aggregator.
     *
     * @param array $params {
     *     @type string     $business_name      Merchant's registered business name (required)
     *     @type string     $settlement_bank    Bank code or name (required)
     *     @type string     $account_number     10-digit NUBAN account number (required)
     *     @type float|int  $percentage_charge  Percentage of transaction the merchant receives 0–100 (required)
     *     @type string     $description        Optional description
     * }
     *
     * @return array Response with subaccount code and details
     *
     * @example
     *   $sub = $client->subaccount->create([
     *       'business_name'      => 'Shoprite Nigeria',
     *       'settlement_bank'    => 'GTB',
     *       'account_number'     => '0123456789',
     *       'percentage_charge'  => 70, // merchant receives 70%
     *   ]);
     */
    public function create(array $params): array
    {
        foreach (['business_name', 'settlement_bank', 'account_number'] as $field) {
            if (empty($params[$field])) {
                throw new PaylodeValidationException("{$field} is required", $field);
            }
        }

        if (!isset($params['percentage_charge'])) {
            throw new PaylodeValidationException('percentage_charge is required', 'percentage_charge');
        }

        $pct = (float) $params['percentage_charge'];
        if ($pct < 0.0 || $pct > 100.0) {
            throw new PaylodeValidationException(
                'percentage_charge must be between 0 and 100',
                'percentage_charge'
            );
        }

        $body = [
            'business_name'     => $params['business_name'],
            'settlement_bank'   => $params['settlement_bank'],
            'account_number'    => $params['account_number'],
            'percentage_charge' => $pct,
        ];
        if (!empty($params['description'])) {
            $body['description'] = $params['description'];
        }

        return $this->http->request('POST', 'subaccount', $body);
    }

    /**
     * Fetch a subaccount by its code.
     */
    public function fetch(string $subaccountCode): array
    {
        if (empty($subaccountCode)) {
            throw new PaylodeValidationException('subaccountCode is required', 'subaccountCode');
        }
        return $this->http->request('GET', "subaccount/{$subaccountCode}");
    }

    /**
     * List all subaccounts.
     */
    public function list(int $page = 1, int $perPage = 50): array
    {
        $qs = http_build_query(['page' => $page, 'perPage' => $perPage]);
        return $this->http->request('GET', "subaccount?{$qs}");
    }

    /**
     * Update a subaccount — e.g. change settlement bank or percentage_charge.
     */
    public function update(string $subaccountCode, array $params): array
    {
        if (empty($subaccountCode)) {
            throw new PaylodeValidationException('subaccountCode is required', 'subaccountCode');
        }
        return $this->http->request('PUT', "subaccount/{$subaccountCode}", $params);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Settlements
// ────────────────────────────────────────────────────────────────────────────

class Settlements
{
    public function __construct(private readonly Client $http) {}

    /**
     * List settlements.
     *
     * @param int         $page
     * @param int         $perPage
     * @param string|null $fromDate  ISO date e.g. '2025-05-01'
     * @param string|null $toDate    ISO date e.g. '2025-05-31'
     */
    public function list(
        int $page = 1,
        int $perPage = 50,
        ?string $fromDate = null,
        ?string $toDate = null
    ): array {
        $params = ['page' => $page, 'perPage' => $perPage];
        if ($fromDate !== null) $params['from'] = $fromDate;
        if ($toDate !== null)   $params['to']   = $toDate;

        return $this->http->request('GET', 'settlement?' . http_build_query($params));
    }

    /**
     * Fetch a single settlement by ID.
     */
    public function fetch(string $settlementId): array
    {
        if (empty($settlementId)) {
            throw new PaylodeValidationException('settlementId is required', 'settlementId');
        }
        return $this->http->request('GET', "settlement/{$settlementId}");
    }
}
