# Part 2 Teller client and normalizer (2026-10-18)

## Request behavior

- Requests go only to `https://api.teller.io`, with `Teller-Version: 2020-10-12`. Access tokens use HTTP Basic authentication.
- Development and production load the client certificate and private key once for a reusable HTTPS agent. Sandbox may omit both. `TELLER_CERTIFICATE_FILE` and `TELLER_PRIVATE_KEY_FILE` can point to injected secret files; otherwise the existing config paths are used. Missing, malformed, mismatched, or expired credentials fail before a request.
- GET requests have a 15-second timeout and at most three attempts. Only transient network failures, HTTP 429, and HTTP 5xx retry. Backoff starts at 250 ms and caps at 2 seconds, including `Retry-After` values. Mutation requests do not retry.
- Typed errors distinguish certificate/token rejection, disconnected enrollment, closed account, unavailable resource, temporary failure, timeout, network failure, invalid response, and invalid request. Provider response bodies and tokens are not included in error messages.

## Account and transaction behavior

- The client asks Teller for inclusive `start_date` and `end_date` bounds and 100 transactions per page. It follows `from_id` until the final short page, rejects a repeated cursor or excessive page count, and deduplicates transaction IDs.
- An optional incremental call expands the start date by ten days. The current CLI still uses its configured date window; Part 4 will provide persistent history and reconciliation.
- Account capability links determine whether balances and transactions can be requested. Missing balances stay absent. Missing transaction capability rejects the account fetch so it cannot appear as an empty successful account.
- Money strings are validated before conversion to the legacy numeric export fields. Teller transactions also retain an exact `amountDecimal` string for later reconciliation, and the original bank date is retained as `dateOnly`. No floating-point reconciliation total is calculated. Nullable categories and counterparty fields become optional output fields.
- The spending-positive sign mapping remains the fork's depository/credit rule. Fixtures cover purchases, refunds, deposits, withdrawals, transfers, card payments, negative balances, and zero. A real depository and credit account must still be compared with statements before release; fixtures alone do not establish Teller's sign behavior at every institution.

## Verification

`npm test` passes with deterministic fixtures for success, pagination, malformed payloads, timeout and retry exhaustion, missing or rejected credentials, missing resources, and numeric/date normalization. No live Teller enrollment or certificate was available for this check.

API behavior was checked against Teller's [versioning](https://teller.io/docs/api), [authentication](https://teller.io/docs/api/authentication), [errors](https://teller.io/docs/api/errors), [accounts](https://teller.io/docs/api/accounts), [balances](https://teller.io/docs/api/account/balances), and [transactions](https://teller.io/docs/api/account/transactions) documentation.
