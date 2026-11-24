# GCP Collector — Deployment Guide, Operational Runbook & Troubleshooting

> **Document:** `04_deployment_and_runbook.md`  
> **Status:** Approved Production Specification  
> **Visibility:** Public & Client-Safe

---

## 1. Quick Automated Deployment (Google Cloud Shell)

For the fastest deployment with zero local software requirements, execute the following script directly in **Google Cloud Shell** within your GCP project:

```bash
curl -sL https://raw.githubusercontent.com/voight-trace/gcp-collector/main/deploy.sh | bash -s -- \
  --api-key="vt_live_your_api_key_here" \
  --site-id="your_site_uuid_here" \
  --region="us-central1"
```

---

## 2. Manual Step-by-Step Deployment (gcloud CLI)

If you prefer to review and execute each command individually:

### Step 1: Set Project & Environment Variables
```bash
export PROJECT_ID=$(gcloud config get-value project)
export REGION="us-central1"
export VOIGHT_API_KEY="vt_live_your_api_key_here"
export VOIGHT_SITE_ID="your_site_uuid_here"
export SA_NAME="voight-collector"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

### Step 2: Enable Required Google Cloud APIs
```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  logging.googleapis.com
```

### Step 3: Create Dedicated Service Account & Assign Least-Privilege IAM
```bash
# 1. Create the dedicated service account
gcloud iam service-accounts create $SA_NAME \
  --display-name="Voight Trace Log Collector"

# 2. Grant roles/logging.viewer to read GLB access logs
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/logging.viewer"

# Wait 10 seconds for IAM policy propagation across Google Cloud's distributed control plane
sleep 10
```

### Step 4: Deploy the Cloud Run Function (2nd Gen)
```bash
cd sources/collectors/gcp-collector

gcloud functions deploy voight-trace-collector \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=collectLogs \
  --trigger-http \
  --no-allow-unauthenticated \
  --service-account=$SA_EMAIL \
  --set-env-vars="VOIGHT_TRACE_API_KEY=${VOIGHT_API_KEY},VOIGHT_TRACE_SITE_ID=${VOIGHT_SITE_ID},LOOKBACK_SECONDS=75"
```

### Step 5: Grant Invocation Permission to Cloud Scheduler
```bash
gcloud functions add-invoker-policy-binding voight-trace-collector \
  --region=$REGION \
  --member="serviceAccount:${SA_EMAIL}"
```

### Step 6: Create the Cloud Scheduler Cron Job (Every 1 Minute)
```bash
FUNC_URL=$(gcloud functions describe voight-trace-collector --gen2 --region=$REGION --format='value(serviceConfig.uri)')

gcloud scheduler jobs create http voight-trace-schedule \
  --location=$REGION \
  --schedule="*/1 * * * *" \
  --uri=$FUNC_URL \
  --http-method=POST \
  --oidc-service-account-email=$SA_EMAIL
```

---

## 3. Operational Verification & Testing

### 3.1. Trigger an Immediate Test Execution
```bash
gcloud scheduler jobs run voight-trace-schedule --location=$REGION
```

### 3.2. Inspect Execution Logs
```bash
gcloud functions logs read voight-trace-collector --gen2 --region=$REGION --limit=30
```
Expected output:
```text
[Voight Trace GCP Collector] Querying logs from 2026-11-24T09:23:45.000Z to 2026-11-24T09:25:00.000Z...
[Voight Trace GCP Collector] Fetched 18 log entries. Transforming observations...
[Voight Trace GCP Collector] Successfully dispatched batch of 18 observations to Voight Trace (HTTP 202 Accepted).
```

---

## 4. Troubleshooting & Common Scenarios

### Scenario A: Function Returns `Fetched 0 log entries` Continuously
* **Root Cause:** Logging is not enabled on the target Backend Service of your Global Load Balancer.
* **Resolution:** In Google Cloud Console, navigate to **Network Services → Load Balancing → Backend Services**, edit your Backend Service, and ensure **Enable Logging** is checked with Sample Rate set to `1.0`.

### Scenario B: `PERMISSION_DENIED` on `logging.entries.list`
* **Root Cause:** The Service Account was created recently and IAM propagation is still completing, or `roles/logging.viewer` was assigned to the wrong project.
* **Resolution:** Verify IAM binding:
  ```bash
  gcloud projects get-iam-policy $PROJECT_ID \
    --flatten="bindings[].members" \
    --format='table(bindings.role)' \
    --filter="bindings.members:${SA_EMAIL}"
  ```
  Ensure `roles/logging.viewer` is listed.

### Scenario C: Cloud Scheduler Returns `403 Forbidden`
* **Root Cause:** Cloud Scheduler lacks permission to invoke the Cloud Run Function.
* **Resolution:** Ensure Step 5 was executed so `roles/run.invoker` is granted to `${SA_EMAIL}` on the function.
