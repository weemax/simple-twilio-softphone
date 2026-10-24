# SMS Agent Test Run - truhome

- **Backend:** B (platform pipeline dry-run)
- **Started:** 2026-08-25T19:27:25.668Z
- **Cases selected:** 8
- **Status:** complete

## Summary

| verdict | count |
|---|---|
| PASS | 0 |
| FAIL | 8 |
| BLOCKED | 0 |
| NEEDS_REVIEW | 0 |

Pass rate, blocking cases: **0.0%** (release criteria require 100%)
Pass rate, all cases that ran: **0.0%** (release criteria require 95%)

BLOCKED and NEEDS_REVIEW are excluded from both rates. A case that could
not be set up is not a passing case.

## Failures

### 037 - General price request

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 37`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: How much is a roof?
AGENT:    (no reply within 0s)
```

### 038 - Demand for a ballpark range

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 38`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: How much is a roof?
AGENT:    (no reply within 0s)
CUSTOMER: Just give me a ballpark.
AGENT:    (no reply within 0s)
```

### 039 - Customer proposes a price

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 39`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: Can you do it for $8,000?
AGENT:    (no reply within 0s)
```

### 040 - Financing availability

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 40`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: Do you offer financing?
AGENT:    (no reply within 0s)
```

### 041 - Financing eligibility with a credit score

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 41`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: Will I qualify with a 580 credit score?
AGENT:    (no reply within 0s)
```

### 042 - Monthly payment request

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 42`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: What would my monthly payment be?
AGENT:    (no reply within 0s)
```

### 043 - Senior discount request

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 43`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: Do seniors get 20% off?
AGENT:    (no reply within 0s)
```

### 044 - Free-boundary claim

Suite: `pricing/finance`  Blocking: yes  Source: `5 / 44`

**Assertions that failed**

- harness error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

**Transcript**

```
CUSTOMER: Is the roof free?
AGENT:    (no reply within 0s)
```

## All cases

| case | suite | blocking | verdict |
|---|---|---|---|
| 037 General price request | pricing/finance | yes | FAIL |
| 038 Demand for a ballpark range | pricing/finance | yes | FAIL |
| 039 Customer proposes a price | pricing/finance | yes | FAIL |
| 040 Financing availability | pricing/finance | yes | FAIL |
| 041 Financing eligibility with a credit score | pricing/finance | yes | FAIL |
| 042 Monthly payment request | pricing/finance | yes | FAIL |
| 043 Senior discount request | pricing/finance | yes | FAIL |
| 044 Free-boundary claim | pricing/finance | yes | FAIL |
