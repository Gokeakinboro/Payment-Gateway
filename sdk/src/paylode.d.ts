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

// ─── Invoice & Collect ─────────────────────────────────────────────────────
export interface InvoiceRecipients {
  email?: string;
  name?: string;
  phone?: string;
  contact_id?: string;
  contact_ids?: string[];
  list_ids?: string[];
  all_contacts?: boolean;
}

export interface InvoiceCreateParams {
  amount: number;                       // kobo
  recipients: InvoiceRecipients;
  description?: string;
  currency?: 'NGN' | 'USD';
  charge_vat?: boolean;
  allow_part_payment?: boolean;
  scheduled_at?: string;                // ISO date
  due_at?: string;                      // ISO date
  reminder_interval_days?: number;
  reminder_count?: number;
  department_id?: string;
}

export interface InvoiceListParams {
  status?: 'draft' | 'scheduled' | 'sent' | 'part_paid' | 'paid' | 'cancelled';
}

export interface QrCreateParams {
  type?: 'fixed' | 'open';
  amount?: number;                      // kobo, required when type === 'fixed'
  label?: string;
  charge_vat?: boolean;
  department_id?: string;
}

export interface ContactParams {
  name: string;
  email?: string;
  phone?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
}

export interface ListParams {
  name: string;
  contact_ids?: string[];
}

export interface ProductParams {
  name: string;
  default_amount?: number;              // kobo
  description?: string;
}

export interface FormatParams {
  logo_url?: string;
  address?: string;
  business_email?: string;
  business_phone?: string;
  layout?: 'classic' | 'modern' | 'minimal' | 'receipt';
  allow_part_payment_default?: boolean;
  charge_vat_default?: boolean;
}

export interface DepartmentUserParams {
  name: string;
  email: string;
  phone?: string;
}

export interface Invoicing {
  invoices: {
    create(params: InvoiceCreateParams): Promise<ApiResponse<unknown>>;
    list(params?: InvoiceListParams): Promise<ApiResponse<unknown[]>>;
    fetch(id: string): Promise<ApiResponse<unknown>>;
    send(id: string): Promise<ApiResponse<unknown>>;
    cancel(id: string): Promise<ApiResponse<unknown>>;
  };
  qr: {
    create(params: QrCreateParams): Promise<ApiResponse<unknown>>;
    list(): Promise<ApiResponse<unknown[]>>;
    setActive(id: string, isActive: boolean): Promise<ApiResponse<unknown>>;
    remove(id: string): Promise<ApiResponse<unknown>>;
  };
  contacts: {
    create(params: ContactParams): Promise<ApiResponse<unknown>>;
    list(params?: Record<string, unknown>): Promise<ApiResponse<unknown[]>>;
    import(rows: Partial<ContactParams>[], onDuplicate?: 'skip' | 'overwrite'): Promise<ApiResponse<unknown>>;
    update(id: string, params: Partial<ContactParams>): Promise<ApiResponse<unknown>>;
    remove(id: string): Promise<ApiResponse<unknown>>;
  };
  lists: {
    create(params: ListParams): Promise<ApiResponse<unknown>>;
    list(): Promise<ApiResponse<unknown[]>>;
    members(id: string): Promise<ApiResponse<unknown[]>>;
    update(id: string, params: { add?: string[]; remove?: string[] }): Promise<ApiResponse<unknown>>;
    remove(id: string): Promise<ApiResponse<unknown>>;
  };
  products: {
    create(params: ProductParams): Promise<ApiResponse<unknown>>;
    list(): Promise<ApiResponse<unknown[]>>;
    remove(id: string): Promise<ApiResponse<unknown>>;
  };
  format: {
    get(): Promise<ApiResponse<unknown>>;
    update(params: FormatParams): Promise<ApiResponse<unknown>>;
  };
  departments: {
    create(params: { name: string }): Promise<ApiResponse<unknown>>;
    list(): Promise<ApiResponse<unknown[]>>;
    remove(id: string): Promise<ApiResponse<unknown>>;
    users(id: string): Promise<ApiResponse<unknown[]>>;
    addUser(id: string, params: DepartmentUserParams): Promise<ApiResponse<unknown>>;
    removeUser(id: string, userMapId: string): Promise<ApiResponse<unknown>>;
  };
  reports: {
    summary(): Promise<ApiResponse<unknown>>;
    transactions(params?: { format?: 'csv'; from?: string; to?: string }): Promise<ApiResponse<unknown>>;
  };
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

  invoicing: Invoicing;

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
