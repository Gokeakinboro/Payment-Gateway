<?php

declare(strict_types=1);

namespace Paylode\Exceptions;

use RuntimeException;

/**
 * Base exception for all Paylode SDK errors.
 */
class PaylodeException extends RuntimeException
{
    public function __construct(
        string $message,
        private readonly string $errorCode = 'PAYLODE_ERROR',
        int $statusCode = 0,
        private readonly mixed $raw = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, $statusCode, $previous);
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }

    public function getStatusCode(): int
    {
        return $this->getCode();
    }

    public function getRaw(): mixed
    {
        return $this->raw;
    }

    public function __toString(): string
    {
        return "PaylodeException(code={$this->errorCode}, message={$this->getMessage()}, status={$this->getCode()})";
    }
}

/**
 * Raised when authentication fails — invalid or missing API key.
 */
class PaylodeAuthException extends PaylodeException
{
    public function __construct(string $message = 'Invalid or missing API key', mixed $raw = null)
    {
        parent::__construct($message, 'AUTH_ERROR', 401, $raw);
    }
}

/**
 * Raised when request parameters fail validation before hitting the API.
 */
class PaylodeValidationException extends PaylodeException
{
    public function __construct(string $message, private readonly ?string $field = null)
    {
        parent::__construct($message, 'VALIDATION_ERROR', 400);
    }

    public function getField(): ?string
    {
        return $this->field;
    }

    public function __toString(): string
    {
        return "PaylodeValidationException(field={$this->field}, message={$this->getMessage()})";
    }
}

/**
 * Raised when the Paylode API returns a non-2xx response.
 */
class PaylodeApiException extends PaylodeException
{
    public function __construct(string $message, string $code, int $statusCode, mixed $raw = null)
    {
        parent::__construct($message, $code, $statusCode, $raw);
    }
}
