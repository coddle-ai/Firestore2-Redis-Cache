# Deployment Instructions for DLQ Support

Your code has been successfully patched with Dead Letter Queue (DLQ) support. Here's what was changed and how to deploy:

## Changes Made

1. **Smart Retry Logic Added**: The service now intelligently determines which errors should retry and which shouldn't
2. **Non-Recoverable Errors**: These will be acknowledged immediately to prevent infinite retries:
   - Missing required fields (like childId)
   - Test data (childId = "12345")
   - 404 Not Found errors
   - 401 Authentication errors
   - 400 Bad Request errors
3. **Recoverable Errors**: These will retry up to 5 times:
   - Network timeouts
   - Connection errors
   - 5xx server errors
4. **Failed Event Logging**: Non-recoverable errors are logged to Firestore collection `processing_failures`

## Deployment Steps

### 1. Deploy the Updated Code

```bash
gcloud auth login
gcloud config set project coddle-d9a2b

# Deploy the service
gcloud run deploy pumpingeventstrigger \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

### 2. Set Up Dead Letter Queue

Run the interactive setup script:

```bash
./setup-dlq-interactive.sh
```

When prompted for subscription names, you'll need to identify them from the list. They typically follow this pattern:
- `eventarc-us-central1-pumpingeventstrigger-[random-id]`
- Look for subscriptions that contain your service names

### 3. Monitor Failed Messages

To check messages in the DLQ:

```bash
# View failed messages
gcloud pubsub subscriptions pull firestore-events-dlq-monitor --auto-ack --limit=10

# Process DLQ messages with the processor
node dlq-processor.js
```

### 4. Check Failed Events in Firestore

Failed events are also logged to Firestore. Check the `processing_failures` collection in your Firebase console.

## Testing

After deployment, the problematic document with childId "12345" should:
1. Fail processing
2. Be logged to the `processing_failures` collection
3. Be acknowledged (no more infinite retries)
4. Optionally appear in the DLQ after 5 attempts (if DLQ is configured)

## Rollback

If needed, restore the original code:
```bash
cp index.js.backup index.js
gcloud run deploy pumpingeventstrigger --source . --region us-central1
```