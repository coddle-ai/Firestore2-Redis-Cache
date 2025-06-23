#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Print commands and their arguments as they are executed
set -x

# Deploy script for TEST Firestore to Redis Cache Cloud Function

PROJECT_ID="coddle-d9a2b"
REGION="us-central1"

echo "Deploying TEST function..."

# Deploy test function for testEvents collection
gcloud functions deploy testEventsTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=testEventsTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=testEvents/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=10 \
  --memory=256MB \
  --timeout=60s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

echo "Test deployment complete!"
echo "You can now test by adding documents to the 'testEvents' collection"