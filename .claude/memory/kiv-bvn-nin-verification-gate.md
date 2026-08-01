---
name: kiv-bvn-nin-verification-gate
description: KIV — once BVN/NIN verification is wired, CONFIRM them against records before the onboarding form can be submitted (Goke 2026-07-08)
metadata:
  node_type: memory
  type: project
---

**KIV (Goke 2026-07-08):** the six identity fields are now **compulsory** (present + 11-digit) on onboarding — enforced frontend + backend (see below). **NEXT step, when BVN/NIN verification is available:** actually **CONFIRM the BVN and NIN against the provider's records BEFORE the form can be submitted** (not just format-check). Ties to [[project-paylode-kyc-verification]] (the verification provider integration — Youverify/etc.).

**DONE 2026-07-08 (PR #95) — fields made compulsory:** name, address, phone, email, **BVN, NIN** required across all onboarding paths.
- Backend `routes/onboarding.js /submit`: server-side per applicant_type — natural (`data.np_identity`: name/address/phone/email + 11-digit bvn & nin), entity (`data.entity_details` + ≥1 principal each with 11-digit bvn & nin — a company has none), aggregator (`data.institution` + `data.contact`). Can't be API-bypassed (negative-tested: missing bvn/nin → `REQUIRED_FIELDS_MISSING`).
- Frontend `onboarding.html`: merchant individual (`np_identity`) + company (`entity_details`+`principals`) already enforced; aggregator `institution` step now requires NIN + 11-digit bvn/nin. Live on 45 + 176.

When the verification integration lands: on submit, call verify(BVN)/verify(NIN) → block submit + show mismatch if they don't match the applicant's name/DOB. Links [[project-paylode-kyc-verification]], [[project-paylode]].
