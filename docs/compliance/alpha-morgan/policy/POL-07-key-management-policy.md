# POL-07 — Cryptographic Key and Secret Management
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-07 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Approved algorithms

| Purpose | Approved | Prohibited |
|---|---|---|
| Symmetric encryption | AES-256-GCM | ECB mode; any key below 256 bits; any use of a static IV |
| Password storage | bcrypt (cost ≥ 12), argon2id | MD5, SHA-1, unsalted hashes, reversible encryption |
| Credential storage | SHA-256 one-way hash | Plaintext storage of any credential |
| Message authentication | HMAC-SHA256 or HMAC-SHA512 | Non-constant-time comparison of MACs |
| Transport | TLS 1.2 minimum, TLS 1.3 preferred | SSLv3, TLS 1.0, TLS 1.1, RC4, 3DES, export ciphers |
| Random generation | Platform CSPRNG (`crypto.randomBytes`) | `Math.random()` for any security purpose |
| Second factor | TOTP RFC 6238 | SMS as a sole second factor for privileged accounts |

## 2. Lifecycle

**Generation** — from a CSPRNG, at the full length for the algorithm, in the
environment where the key will be used. Keys are never generated on a developer
workstation for production use and never transmitted over chat or email.

**Storage** — in environment configuration on the host, or in an approved secrets
manager. **Never** in source control, a ticket, a document, a log or a chat
message. No key is stored alongside the data it protects.

**Distribution** — through the secrets manager or an encrypted channel, to the
minimum set of people, recorded in the register.

**Rotation** — per §4, and **immediately** on suspected exposure, on the departure
of anyone who held it, or on a partner's instruction.

**Revocation** — a compromised key is revoked before any assessment of whether it
was used. Rotate first, investigate second.

**Destruction** — cryptographic erase or secure deletion; recorded in the register.

## 3. Ownership

| Key class | Owner |
|---|---|
| Application encryption and signing keys | Chief Technology Officer |
| Merchant API keys and webhook secrets | The merchant, provisioned by the platform |
| Bank-issued credentials and certificates | **The issuing Bank retains ownership**; Paylode is custodian |
| TLS certificates | CTO, automated renewal |
| Infrastructure and deploy keys | CTO |

No key has fewer than two people who can recover it, and no single person can
destroy a production key without a second approver.

## 4. Rotation schedule

| Key / secret | Maximum age | Trigger for immediate rotation |
|---|---|---|
| Application field-encryption key | 12 months | Exposure; personnel departure |
| JWT signing secret | 12 months | Exposure; suspected session compromise |
| Merchant API keys | **90 days** | Merchant request; exposure; account compromise |
| Merchant webhook secrets | 12 months | Merchant request; exposure |
| Partner and Bank API credentials | Per the partner's policy, **maximum 12 months** | Exposure; partner instruction |
| Infrastructure and deploy SSH keys | 12 months | Personnel departure; exposure |
| TLS certificates | 90 days (Let's Encrypt, automated) | Private key exposure |

Rotation of the field-encryption key requires a key-version column so records
encrypted under the previous key remain readable during re-encryption. Plan the
re-encryption before the first rotation, not during it.

## 5. Secret scanning and prevention

1. **Pre-commit** — `gitleaks` blocks a commit containing a credential pattern.
2. **Repository** — GitHub secret scanning with **push protection** enabled.
3. **Periodic** — a full history scan quarterly, with the report retained as
   evidence for item 5.6.
4. **On detection** — Playbook A in POL-04: rotate, purge, review access logs,
   add the missing control.

## 6. Appendix A — Key and certificate inventory

| Key / secret | Owner | Storage | Created | Last rotated | Next due | Blast radius |
|---|---|---|---|---|---|---|
| Field-encryption key | CTO | ⬜ | ⬜ | ⬜ | ⬜ | Settlement account numbers |
| JWT signing secret | CTO | ⬜ | ⬜ | ⬜ | ⬜ | All active sessions |
| PalmPay credentials | CTO | ⬜ | ⬜ | ⬜ | ⬜ | PalmPay rail |
| Parallex credentials | CTO | ⬜ | ⬜ | ⬜ | ⬜ | Parallex rail |
| Interswitch credentials | CTO | ⬜ | ⬜ | ⬜ | ⬜ | Card rail |
| **Alpha Morgan Bank credentials** | CTO | ⬜ | ⬜ | ⬜ | ⬜ | Bank integration |
| KYC provider key | CTO | ⬜ | ⬜ | ⬜ | ⬜ | KYC integration |
| Storage provider key | CTO | ⬜ | ⬜ | ⬜ | ⬜ | KYC documents |
| Deploy SSH key | CTO | GitHub secret | ⬜ | ⬜ | ⬜ | Both hosts (frontend path) |
| TLS certificate — `paylodeservices.com` | CTO | Certbot | auto | auto | auto | Public TLS |
| TLS certificate — `api.paylodeservices.com` | CTO | Certbot | auto | auto | auto | API TLS |

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
