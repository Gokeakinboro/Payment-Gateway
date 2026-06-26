<?php

declare(strict_types=1);

namespace Paylode\Http;

use Paylode\Exceptions\PaylodeApiException;
use Paylode\Exceptions\PaylodeAuthException;
use Paylode\Exceptions\PaylodeException;

class Client
{
    private const BASE_URL    = 'https://api.paylodeservices.com';
    private const API_VERSION = 'v1';
    private const TIMEOUT     = 30;

    public function __construct(private readonly string $secretKey) {}

    /**
     * Make an HTTP request to the Paylode API.
     *
     * @param string     $method  HTTP method (GET, POST, PUT, DELETE)
     * @param string     $path    API path e.g. 'transaction/initialize'
     * @param array|null $body    Request body (for POST/PUT)
     *
     * @return array Decoded JSON response
     *
     * @throws PaylodeAuthException   On 401 responses
     * @throws PaylodeApiException    On other non-2xx responses
     * @throws PaylodeException       On network errors
     */
    public function request(string $method, string $path, ?array $body = null): array
    {
        if (!extension_loaded('curl')) {
            throw new PaylodeException(
                'The cURL extension is required. Enable ext-curl in your PHP configuration.',
                'CURL_MISSING'
            );
        }

        $url     = sprintf('%s/%s/%s', self::BASE_URL, self::API_VERSION, ltrim($path, '/'));
        $headers = $this->buildHeaders();
        $payload = $body !== null ? json_encode($body, JSON_THROW_ON_ERROR) : null;

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }

        $response   = curl_exec($ch);
        $statusCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError  = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            throw new PaylodeException(
                "Network error: {$curlError}",
                'NETWORK_ERROR',
                0
            );
        }

        $parsed = json_decode((string) $response, true, 512, JSON_THROW_ON_ERROR);

        if ($statusCode >= 200 && $statusCode < 300) {
            return $parsed;
        }

        if ($statusCode === 401) {
            throw new PaylodeAuthException(
                $parsed['message'] ?? 'Authentication failed',
                $parsed
            );
        }

        throw new PaylodeApiException(
            $parsed['message'] ?? "API error {$statusCode}",
            $parsed['error_code'] ?? 'API_ERROR',
            $statusCode,
            $parsed
        );
    }

    private function buildHeaders(): array
    {
        return [
            "Authorization: Bearer {$this->secretKey}",
            'Content-Type: application/json',
            'Accept: application/json',
            'X-Paylode-SDK: php/' . \Paylode\Paylode::VERSION,
            'X-Paylode-PHP: ' . PHP_VERSION,
        ];
    }
}
