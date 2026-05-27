// Paylode Node.js SDK — TypeScript Definitions
// paylode-node v1.0.0

export interface PaylodeOptions {
  sandbox?: boolean;
}

export interface TransactionInitParams {
  email: string;
  amount: number;           // in kobo
  reference?: string;
  currency?: 'NGN';
  callback_url?: string;
  channels?: ('card' | 'bank_transfer' | 'ussd' | 'direct_debit')[];
  metadata?: Record<string, unknown>;
}

export interface TransactionListParams {
  page?: number;
  perPage?: number;
  status?: 'success' | 'failed' | 'pending';
  from?: string;
  to?: string;
}

export interface TransactionData {
  id: string;
  reference: string;
  status: 'success' | 'failed' | 'pending';
  amount: number;
  currency: string;
  channel: string;
  authorization_url?: string;
  access_code?: string;
  customer: { email: string; first_name: string; last_name: string };
  metadata: Record<string, unknown>;
  paid_at: string;
  created_at: string;
  fees: number;
  merchant_id: string;
  kyc_tier: 'tier_1' | 'tier_2' | 'tier_3';
}

export interface ApiResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface KycLimitTier {
  single_txn: number;
  daily: number;
  monthly: number | null;
  channels: string[];
}

export interface KycLimits {
  tier_1: KycLimitTier;
  tier_2: KycLimitTier;
  tier_3: KycLimitTier;
}

export interface CustomerParams {
  email: string;
  first_name: string;
  last_name: string;
  phone?: string;
  metadata?: Record<string, unknown>;
}

export interface SubaccountParams {
  business_name: string;
  settlement_bank: string;
  account_number: string;
  percentage_charge: number;
  description?: string;
}

export declare class PaylodeError extends Error {
  code: string;
  statusCode: number;
  raw: unknown;
  constructor(message: string, code: string, statusCode: number, raw?: unknown);
}

export declare class Paylode {
  constructor(secretKey: string, options?: PaylodeOptions);
  readonly version: string;
  readonly sandbox: boolean;
  readonly kycLimits: KycLimits;

  transaction: {
    initialize(params: TransactionInitParams): Promise<ApiResponse<TransactionData>>;
    verify(reference: string): Promise<ApiResponse<TransactionData>>;
    list(params?: TransactionListParams): Promise<ApiResponse<TransactionData[]>>;
    fetch(id: string): Promise<ApiResponse<TransactionData>>;
    refund(reference: string, amount?: number, reason?: string): Promise<ApiResponse<unknown>>;
  };

  customer: {
    create(params: CustomerParams): Promise<ApiResponse<unknown>>;
    fetch(emailOrCode: string): Promise<ApiResponse<unknown>>;
    list(params?: Record<string, unknown>): Promise<ApiResponse<unknown[]>>;
    update(code: string, params: Partial<CustomerParams>): Promise<ApiResponse<unknown>>;
  };

  subaccount: {
    create(params: SubaccountParams): Promise<ApiResponse<unknown>>;
    fetch(code: string): Promise<ApiResponse<unknown>>;
    list(params?: Record<string, unknown>): Promise<ApiResponse<unknown[]>>;
    update(code: string, params: Partial<SubaccountParams>): Promise<ApiResponse<unknown>>;
  };

  settlement: {
    list(params?: Record<string, unknown>): Promise<ApiResponse<unknown[]>>;
    fetch(id: string): Promise<ApiResponse<unknown>>;
  };

  static webhooks: {
    verify(rawBody: string | Buffer, signature: string, secret: string): boolean;
    middleware(secret: string): (req: unknown, res: unknown, next: () => void) => void;
  };

  static utils: {
    generateRef(prefix?: string): string;
    koboToNaira(kobo: number): string;
    nairaToKobo(naira: number): number;
  };
}

export default Paylode;
