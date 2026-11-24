#!/usr/bin/env bash
# ==============================================================================
# Voight Trace — GCP Collector Automated 1-Click Deployment Script
# Target: Google Cloud Global External Application Load Balancer (GLB)
# ==============================================================================

set -euo pipefail

# Default values
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-}"
API_KEY="${VOIGHT_TRACE_API_KEY:-}"
SITE_ID="${VOIGHT_TRACE_SITE_ID:-}"
LOOKBACK_SECONDS="${LOOKBACK_SECONDS:-75}"
INGEST_URL="${VOIGHT_TRACE_INGEST_URL:-https://voighttrace.vercel.app/api/v1/ingestion/events}"

# Parse command line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id=*|--project=*|-p=*)
      PROJECT_ID="${1#*=}"
      shift
      ;;
    --api-key=*)
      API_KEY="${1#*=}"
      shift
      ;;
    --site-id=*)
      SITE_ID="${1#*=}"
      shift
      ;;
    --region=*)
      REGION="${1#*=}"
      shift
      ;;
    --ingest-url=*)
      INGEST_URL="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./deploy.sh --api-key=vt_live_... --site-id=018f2d5e... [--project-id=my-gcp-project] [--region=us-central1]"
      exit 1
      ;;
  esac
done

if [[ -z "$API_KEY" || -z "$SITE_ID" ]]; then
  echo "Error: Missing required parameters."
  echo "Usage: ./deploy.sh --api-key=vt_live_... --site-id=018f2d5e... [--project-id=my-gcp-project] [--region=us-central1]"
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: No active GCP project found."
  echo "Please provide --project-id=YOUR_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "======================================================================"
echo "🚀 VOIGHT TRACE — GCP COLLECTOR DEPLOYMENT"
echo "======================================================================"
echo "Project ID : $PROJECT_ID"
echo "Region     : $REGION"
echo "Site ID    : $SITE_ID"
echo "Ingest URL : $INGEST_URL"
echo "======================================================================"

# 1. Enable Required APIs
echo "▶️ [1/5] Enabling Google Cloud APIs..."
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  logging.googleapis.com \
  --project="$PROJECT_ID"

# 2. Setup Dedicated Service Account
SA_NAME="voight-collector"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "▶️ [2/5] Configuring Service Account ($SA_EMAIL)..."
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Voight Trace Log Collector" \
    --project="$PROJECT_ID"
  echo "Service account created. Waiting 10s for IAM propagation..."
  sleep 10
fi

# Assign least privilege role
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/logging.viewer" \
  --condition=None \
  --quiet >/dev/null

# 3. Deploy Cloud Run Function (2nd Gen)
echo "▶️ [3/5] Deploying Cloud Run Function (2nd Gen: voight-trace-collector)..."
gcloud functions deploy voight-trace-collector \
  --gen2 \
  --runtime=nodejs20 \
  --region="$REGION" \
  --source=. \
  --entry-point=collectLogs \
  --trigger-http \
  --no-allow-unauthenticated \
  --service-account="$SA_EMAIL" \
  --set-env-vars="VOIGHT_TRACE_API_KEY=${API_KEY},VOIGHT_TRACE_SITE_ID=${SITE_ID},VOIGHT_TRACE_INGEST_URL=${INGEST_URL},LOOKBACK_SECONDS=${LOOKBACK_SECONDS}" \
  --project="$PROJECT_ID" \
  --quiet

# 4. Grant Scheduler Invocation Permission
echo "▶️ [4/5] Granting Cloud Scheduler invocation permission..."
gcloud functions add-invoker-policy-binding voight-trace-collector \
  --region="$REGION" \
  --member="serviceAccount:${SA_EMAIL}" \
  --project="$PROJECT_ID" \
  --quiet

# 5. Create / Update Cloud Scheduler Job
echo "▶️ [5/5] Configuring Cloud Scheduler (Cron: */1 * * * *)..."
FUNC_URL=$(gcloud functions describe voight-trace-collector --gen2 --region="$REGION" --project="$PROJECT_ID" --format='value(serviceConfig.uri)')

if gcloud scheduler jobs describe voight-trace-schedule --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud scheduler jobs update http voight-trace-schedule \
    --location="$REGION" \
    --schedule="*/1 * * * *" \
    --uri="$FUNC_URL" \
    --http-method=POST \
    --oidc-service-account-email="$SA_EMAIL" \
    --project="$PROJECT_ID" \
    --quiet
else
  gcloud scheduler jobs create http voight-trace-schedule \
    --location="$REGION" \
    --schedule="*/1 * * * *" \
    --uri="$FUNC_URL" \
    --http-method=POST \
    --oidc-service-account-email="$SA_EMAIL" \
    --project="$PROJECT_ID" \
    --quiet
fi

echo "======================================================================"
echo "🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "Voight Trace GCP Collector is active and scheduled every 1 minute."
echo "Trigger test run with: gcloud scheduler jobs run voight-trace-schedule --location=$REGION"
echo "======================================================================"
