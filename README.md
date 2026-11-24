# Voight Trace — GCP Collector (Cloud Run Functions & GLB)

[![Google Cloud](https://img.shields.io/badge/Google_Cloud-4285F4?logo=google-cloud&logoColor=white)](https://cloud.google.com)
[![Cloud Run](https://img.shields.io/badge/Cloud_Run_Functions-2nd_Gen-4285F4)](https://cloud.google.com/run)
[![license](https://img.shields.io/badge/license-Apache--2.0-green.svg)](https://voighttrace.com)

The **Voight Trace GCP Collector** (`@voight-trace/gcp-collector`) is an asynchronous, zero-latency edge observation collector for applications fronted by the **Google Cloud Global External Application Load Balancer (GLB)**.

It executes inside your Google Cloud project (**BYOC — Bring Your Own Cloud**) as a **2nd Generation Cloud Run Function**, scheduled once per minute by **Cloud Scheduler**. It reads HTTP access logs emitted by the GLB into **Cloud Logging**, sanitizes all headers, and streams batched observations to the Voight Trace Ingestion API.

---

## ⚡ 100% Zero Latency Impact (Out-of-Band)

* **No Proxy Overhead:** Traditional proxies or synchronous Envoy callouts add 50ms–300ms of latency to every visitor request.
* **Asynchronous Telemetry:** Google Cloud Load Balancing commits access logs to Cloud Logging out-of-band. The collector queries these logs in the background. **Your visitors experience 0ms added latency.**
* **Fail-Safe:** If Voight Trace experiences transient downtime, your website and APIs remain 100% unaffected.

---

## 💰 Google Cloud Free Tier Breakdown (100% Free)

Google Cloud provides an **Always Free** tier that completely covers the monthly operating costs of the Voight Trace GCP Collector:

| GCP Service | Monthly Free Tier Quota | Voight Collector Monthly Consumption | Free Tier Utilization | Cost |
| :--- | :--- | :--- | :--- | :--- |
| **Cloud Run Functions** (Invocations) | **2,000,000 calls / month** | ~43,200 calls (1 call / min) | **2.16%** | **$0.00** |
| **Compute Time** (Memory) | **400,000 GB-seconds / month** | ~5,400 GB-seconds (256MB @ 0.5s) | **1.35%** | **$0.00** |
| **Compute Time** (CPU) | **200,000 GHz-seconds / month** | ~2,160 GHz-seconds | **1.08%** | **$0.00** |
| **Network Egress** (Outbound) | **5 GB / month** (Global/US) | ~150 MB / month (Gzip batched) | **3.00%** | **$0.00** |
| **Cloud Scheduler** | **3 jobs / month free** | 1 cron job (`voight-trace-schedule`) | **33.3%** | **$0.00** |
| **Cloud Logging** | **First 50 GiB / month free** | Variable by website traffic | First 50 GB free | **$0.00** |
| **Total Estimated Cost** | — | — | — | **$0.00 / mo** |

### ⚠️ Important Google Cloud Billing Notes:
1. **Active Billing Account Required:** Although usage stays completely within the Free Tier limits ($0.00/month), Google Cloud requires a verified billing account (credit card) linked to the project to enable Cloud Run Functions.
2. **Artifact Registry Image Storage:** Cloud Run Functions store container images in Google Artifact Registry, which offers 0.5 GB free storage per month. Old deployment images can be safely deleted or automatically pruned via an Artifact Registry cleanup policy.
3. **Cloud Build:** Function deployments consume Cloud Build time. Google provides **120 free build-minutes per day**, while a typical deployment takes less than 2 minutes.

---

## 🚀 1-Minute Cloud Shell Deployment

Open [Google Cloud Shell](https://shell.cloud.google.com) in your target GCP project and run:

```bash
curl -sL https://raw.githubusercontent.com/voight-trace/gcp-collector/main/deploy.sh | bash -s -- \
  --api-key="YOUR_VOIGHT_API_KEY" \
  --site-id="YOUR_VOIGHT_SITE_ID" \
  --region="us-central1"
```

The script will automatically:
1. Enable required APIs (`cloudfunctions`, `cloudscheduler`, `run`, `logging`, `cloudbuild`).
2. Create a dedicated least-privilege service account (`voight-collector`).
3. Deploy the 2nd Gen Cloud Run Function.
4. Configure Cloud Scheduler to trigger the function once per minute via authenticated OIDC.
5. Trigger an initial test run.

---

## 📋 Manual Setup & Step-by-Step CLI

If you prefer deploying with custom configuration:

### 1. Enable Google Cloud APIs
```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  logging.googleapis.com
```

### 2. Create Service Account & Assign Least-Privilege IAM
```bash
PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
SA_NAME="voight-collector"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Create service account
gcloud iam service-accounts create $SA_NAME --display-name="Voight Trace Log Collector"

# Grant read-only access to Cloud Logging
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/logging.viewer"

sleep 10
```

### 3. Deploy the Cloud Run Function
```bash
gcloud functions deploy voight-trace-collector \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=collectLogs \
  --trigger-http \
  --no-allow-unauthenticated \
  --service-account=$SA_EMAIL \
  --set-env-vars="VOIGHT_TRACE_API_KEY=vt_live_your_key,VOIGHT_TRACE_SITE_ID=your_site_id,LOOKBACK_SECONDS=75"
```

### 4. Create the 1-Minute Cloud Scheduler Cron Job
```bash
# Allow the service account to invoke the function
gcloud functions add-invoker-policy-binding voight-trace-collector \
  --region=$REGION \
  --member="serviceAccount:${SA_EMAIL}"

# Get the HTTP endpoint URI
FUNC_URL=$(gcloud functions describe voight-trace-collector --gen2 --region=$REGION --format='value(serviceConfig.uri)')

# Create the cron job
gcloud scheduler jobs create http voight-trace-schedule \
  --location=$REGION \
  --schedule="*/1 * * * *" \
  --uri=$FUNC_URL \
  --http-method=POST \
  --oidc-service-account-email=$SA_EMAIL
```

---

## 🔒 Privacy & Security by Design (Header Sanitization)

The GCP Collector enforces an **immutable allowlist policy (`SAFE_AUDIT_HEADERS`)** before creating any telemetry batch:

### 🚫 Prohibited Headers — NEVER Extracted or Transmitted:
* ❌ `Authorization` / `Proxy-Authorization` (Bearer tokens, Basic Auth, JWTs)
* ❌ `Cookie` / `Set-Cookie` (Session identifiers, tracking cookies)
* ❌ `X-Api-Key` / `Api-Key` / `X-Auth-Token` (Customer private application secrets)
* ❌ Passwords or request payload bodies (POST/PUT payloads)

### ✅ Permitted Headers (`SAFE_AUDIT_HEADERS`):
* **Core AI & Traffic Identification:** `user-agent` (detects AI crawlers & LLM agents), `referer` (detects human referrals from ChatGPT, Claude, Perplexity), `host`, `origin`
* **Content Negotiation:** `accept`, `accept-encoding`, `accept-language`, `content-type`
* **Client Hints (Browser Architecture):** `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `sec-ch-ua-platform-version`, `sec-ch-ua-model`, `sec-ch-ua-arch`
* **Request Metadata:** `sec-fetch-dest`, `sec-fetch-mode`, `sec-fetch-site`, `sec-fetch-user`

---

## 📖 Specifications & Architecture Documentation (SDD)

For in-depth architectural and operational specifications, explore the internal documentation in `docs/`:

* [`docs/01_architecture_and_design.md`](./docs/01_architecture_and_design.md): System architecture, BYOC security model, and out-of-band flow.
* [`docs/02_cloud_logging_spec_and_schemas.md`](./docs/02_cloud_logging_spec_and_schemas.md): Cloud Logging `LogEntry` schema and transformation mapping.
* [`docs/03_security_iam_and_privacy.md`](./docs/03_security_iam_and_privacy.md): IAM least privilege, Application Default Credentials, and LGPD/GDPR compliance.
* [`docs/04_deployment_and_runbook.md`](./docs/04_deployment_and_runbook.md): Operational runbook, troubleshooting guide, and verification steps.
