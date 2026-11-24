# Security Architecture, IAM Policies & Privacy Specification

> **Document:** `03_security_iam_and_privacy.md`  
> **Status:** Approved Production Specification  
> **Methodology:** Principle of Least Privilege & Privacy by Design  
> **Visibility:** Public & Client-Safe (Zero internal secrets, keys, or private identifiers)

---

## 1. Security Architecture Principles

The **Voight Trace GCP Collector** is built from the ground up for strict enterprise compliance, ensuring zero data leakage, zero credential sharing, and complete isolation within the customer's Google Cloud perimeter.

### 1.1. Core Security Guarantees
1. **Bring Your Own Cloud (BYOC) Boundary:** The collector runs inside the customer's project. Customer logs never leave their project boundary without explicit sanitization and filtering.
2. **Zero Cross-Project IAM Access:** Voight Trace never requests permissions on the customer's GCP organization.
3. **No Stored Secret Files:** The function utilizes **Application Default Credentials (ADC)** provided natively by the Cloud Run runtime metadata server. No Service Account JSON key files are generated, downloaded, or transferred.

---

## 2. Google Cloud IAM Least-Privilege Role Matrix

The collector operates with the minimum set of permissions strictly required to read load balancer access logs and receive scheduled invocations.

| Identity / Service Account | Required IAM Role | Scope / Resource | Purpose |
| :--- | :--- | :--- | :--- |
| `voight-collector@PROJECT_ID.iam.gserviceaccount.com` | `roles/logging.viewer` | `projects/PROJECT_ID` | Reads `http_load_balancer` logs from Cloud Logging via `entries.list`. |
| `voight-collector@PROJECT_ID.iam.gserviceaccount.com` | `roles/run.invoker` | `voight-trace-collector` Function | Grants Cloud Scheduler permission to invoke the Cloud Run Function via OIDC token. |

### 2.1. Why `roles/logging.viewer` is Safe
* Grants read-only access to log metadata and log entries.
* Does **not** grant permission to modify, delete, or create log sinks, log buckets, or any other Google Cloud resource.
* The function executes queries strictly filtered by `resource.type="http_load_balancer"`.

---

## 3. Strict Header Allowlist Policy (`SAFE_AUDIT_HEADERS`)

In adherence with global privacy regulations (GDPR, Brazilian LGPD, CCPA) and enterprise SOC2 compliance, the collector implements an **immutable allowlist** of headers.

```javascript
export const SAFE_AUDIT_HEADERS = Object.freeze([
  // Core AI & Traffic Identification (Never contains credentials or tokens)
  'user-agent',
  'referer',
  'host',
  'origin',

  // Content Negotiation
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',

  // Client Hints (Browser Architecture & Device Detection)
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-model',
  'sec-ch-ua-arch',

  // Request & Fetch Context
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user'
]);
```

### 3.1. Prohibited Headers — Stored or Transmitted: NEVER
Any header capable of carrying authentication credentials or user tracking tokens is **strictly stripped at the source**:
* ❌ `Authorization` / `Proxy-Authorization` (Bearer tokens, Basic Auth, JWTs)
* ❌ `Cookie` / `Set-Cookie` (Session identifiers, auth cookies, tracking tokens)
* ❌ `X-Api-Key` / `Api-Key` / `X-Auth-Token` (Customer private application keys)
* ❌ Passwords, secret headers, or request payload bodies (POST/PUT data)

---

## 4. Privacy & Anonymization (LGPD / GDPR Compliance)

### 4.1. IP Address Handling
* The collector transmits the remote IP (`httpRequest.remoteIp`) over encrypted TLS 1.3 to the Voight Trace Ingestion API.
* The Ingestion API immediately pseudonimizes the IP using a one-way **HMAC-SHA256 hash** combined with a tenant-isolated salt before persistence.
* Raw IP addresses are **never stored** in the ClickHouse analytical database.

### 4.2. Query String Sanitization
* URL query parameters are passed through standard query parsing.
* Known sensitive parameters (e.g., `token`, `auth`, `access_token`, `password`, `key`) are stripped prior to ingestion processing.
