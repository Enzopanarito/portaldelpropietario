# VLA Payment Report — Proof First v9

Release prepared on 2026-08-12.

## Owner experience

- Digital payment starts with the proof image/PDF.
- Amount, currency, method, reference and transaction metadata are extracted automatically when possible.
- Missing bank/method or reference does not force the owner to type those fields before reporting.
- VLA infers the target USD or Bs account when the current balances make the destination unambiguous.
- If a critical value is genuinely ambiguous, the owner is asked only for that exception instead of receiving a full form.
- Technical AI confidence is kept out of the owner-facing interface.

## Financial safety

- Reporting a payment does not change balances.
- Automatic approval remains controlled by the deterministic arbiter.
- The verified background reference takes precedence when the definitive payment and receipt are created.
- USD and Bs balances remain independent.
- Duplicate protection, encryption, idempotency, monthly-close locks and access recalculation are unchanged.

## Pre-production certification

The isolated GitHub laboratory completed successfully before production publication:

- 286/286 repository tests passed.
- Canonical 15-house balance tests passed.
- Focused payment/date/duplicate/reference tests passed.
- Public production build completed successfully.
- Three Playwright/Chromium payment browser gates passed, including proof-first v9 and duplicate replacement behavior.
- No Netlify Deploy Preview was used for this release.

Production remains gated by the standard workflow: tests and browser gates first, immediate financial BEFORE snapshot, one prepared Netlify production deploy, exact commit/runtime/release verification, then 15 houses × 10 financial fields with required BEFORE/AFTER difference of $0.00.
