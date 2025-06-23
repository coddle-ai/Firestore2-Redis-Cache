#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Print commands and their arguments as they are executed
set -x

# Deploy script for Firestore to Redis Cache Cloud Functions

PROJECT_ID="coddle-d9a2b"
REGION="us-central1"

# Install dependencies
echo "Installing dependencies..."
npm install

# Deploy function for feedEvents collection
gcloud functions deploy feedEventsTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=feedEventsTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=feedEvents/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

# Deploy function for diaperEvents collection
gcloud functions deploy diaperEventsTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=diaperEventsTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=diaperEvents/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

# Deploy function for sleepEvents collection
gcloud functions deploy sleepEventsTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=sleepEventsTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=sleepEvents/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

# Deploy function for pumpingEvents collection
gcloud functions deploy pumpingEventsTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=pumpingEventsTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=pumpingEvents/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

# Deploy function for child_profile collection
gcloud functions deploy childProfileTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=childProfileTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=child_profile/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

# Deploy function for child_questionnaire collection
gcloud functions deploy childQuestionnaireTrigger \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --source=. \
  --entry-point=childQuestionnaireTrigger \
  --trigger-event-filters="type=google.cloud.firestore.document.v1.written" \
  --trigger-event-filters="database=(default)" \
  --trigger-event-filters-path-pattern="document=child_questionnaire/{docId}" \
  --trigger-location=nam5 \
  --env-vars-file=env.yaml \
  --max-instances=100 \
  --memory=512MB \
  --timeout=120s \
  --retry \
  --vpc-connector=projects/coddle-d9a2b/locations/us-central1/connectors/default-vpc-connector

echo "Deployment complete!"