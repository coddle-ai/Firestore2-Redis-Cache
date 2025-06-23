# Firestore to Redis Cache Sync

This project implements Cloud Functions that automatically sync data from Firestore collections to Redis cache when documents are created, updated, or deleted. The cached data is used by the backend application for fast access to aggregated child activity data and profile information.

## Architecture Overview

```
Firestore Collections → Cloud Functions → External APIs → Redis Cache → Backend Application
```

### System Components:
- **6 Firestore Collections**: Activity and profile data sources
- **6 Cloud Functions**: Event-triggered processors
- **4 External APIs**: Data enrichment services
- **1 Redis Cluster**: High-performance cache storage
- **VPC Connector**: Secure network access

## Monitored Firestore Collections

The system monitors two types of collections:

### Activity Collections
These collections track child activities and trigger summary/log updates:

1. **`feedEvents`** - Feeding activity records
2. **`diaperEvents`** - Diaper change records  
3. **`sleepEvents`** - Sleep activity records
4. **`pumpingEvents`** - Pumping session records

### Profile Collections
These collections store child information and trigger profile updates:

5. **`child_profile`** - Child profile information
6. **`child_questionnaire`** - Child questionnaire responses

Each document in ALL collections must contain:
- `parentId` (string) - The parent's unique identifier
- `childId` (string) - The child's unique identifier

## Data Flow

### For Activity Collections (feedEvents, diaperEvents, sleepEvents, pumpingEvents):
1. **Firestore Event Trigger**: When a document is created/updated/deleted
2. **Cloud Function Activation**: The corresponding Cloud Function is triggered
3. **Data Extraction**: Extract `parentId` and `childId` from the document
4. **API Authentication**: Fetch authentication token
5. **Data Retrieval**: Call APIs to get:
   - 7-day summary data
   - Current day logs
6. **Redis Storage**: Store activity data in Redis

### For Profile Collections (child_profile, child_questionnaire):
1. **Firestore Event Trigger**: When a document is created/updated/deleted
2. **Cloud Function Activation**: The corresponding Cloud Function is triggered
3. **Data Extraction**: Extract `parentId` and `childId` from the document
4. **API Authentication**: Fetch authentication token
5. **Profile Retrieval**: Call child profile API to get updated profile data
6. **Redis Storage**: Store profile data in Redis

## External APIs Called

### 1. Authentication Token API
```
GET https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/token/{parentId}

Response:
{
  "token": "bearer_token_string"
}
```

### 2. 7-Day Summary API
```
POST https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/summary

Request Body:
{
  "childId": "child_id",
  "parentId": "parent_id",
  "timeZone": "America/Los_Angeles",
  "flType": "ML"
}

Headers:
- Authorization: Bearer {token}
```

### 3. Current Day Logs API
```
POST https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/current-logs

Request Body:
{
  "childId": "child_id",
  "timeZone": "America/Los_Angeles"
}

Headers:
- Authorization: Bearer {token}
```

### 4. Child Profile API
```
GET https://api-3sfdwjc2da-uc.a.run.app/child-profile/{childId}

Headers:
- Authorization: Bearer {token}

Response includes:
- name
- dateOfBirth
- gender
- estimatedDate (optional)
- questionaire (optional)
```

## Redis Cache Keys

The backend application can retrieve cached data using these Redis keys:

### 1. Summary Data Key
```
Key: summary:{childId}
TTL: 24 hours (86400 seconds)

Value Structure:
{
  "data": {
    // 7-day summary data from API
  },
  "expiresAt": timestamp_in_milliseconds
}
```

### 2. Day Log Data Key
```
Key: daylog:{childId}
TTL: 30 minutes (1800 seconds)

Value Structure:
{
  "data": {
    "sleep": [...],
    "feed": [...],
    "diaper": [...],
    "pumping": [...]
  },
  "expiresAt": timestamp_in_milliseconds
}
```

### 3. Combined Parent-Child Data Key (Activity Collections)
```
Key: parent:{parentId}:child:{childId}
TTL: 1 hour (3600 seconds)

Value Structure:
{
  "last7daySummary": {...},
  "currentDayLogs": {...},
  "lastUpdated": "ISO_8601_timestamp",
  "eventSource": "collection_name"
}
```

### 4. Child Profile Key
```
Key: profile:{childId}
TTL: 24 hours (86400 seconds)

Value Structure:
{
  "data": {
    "name": "string",
    "dateOfBirth": "string",
    "gender": "string",
    "estimatedDate": "string",
    "questionaire": {...}
  },
  "expiresAt": timestamp_in_milliseconds
}
```

### 5. Profile Parent-Child Key
```
Key: profile:parent:{parentId}:child:{childId}
TTL: 24 hours (86400 seconds)

Value Structure:
{
  "profile": {
    "name": "string",
    "dateOfBirth": "string",
    "gender": "string",
    "estimatedDate": "string",
    "questionaire": {...}
  },
  "lastUpdated": "ISO_8601_timestamp",
  "eventSource": "child_profile" or "child_questionnaire"
}
```

## Backend Integration

To retrieve cached data in your backend application:

```javascript
// Example using Node.js Redis client
const redis = require('redis');
const client = redis.createClient({/* your config */});

// Get 7-day summary for a child
const summaryData = await client.get(`summary:${childId}`);
const summary = JSON.parse(summaryData);

// Get current day logs
const dayLogData = await client.get(`daylog:${childId}`);
const dayLogs = JSON.parse(dayLogData);

// Get combined data for parent-child pair
const combinedData = await client.get(`parent:${parentId}:child:${childId}`);
const combined = JSON.parse(combinedData);

// Get child profile data
const profileData = await client.get(`profile:${childId}`);
const profile = JSON.parse(profileData);

// Get profile with parent-child context
const profileWithParent = await client.get(`profile:parent:${parentId}:child:${childId}`);
const profileContext = JSON.parse(profileWithParent);
```

## Deployment

### Prerequisites
1. Google Cloud project with Firestore enabled
2. Redis cluster accessible via VPC
3. VPC connector configured for Cloud Functions
4. Service account with necessary permissions

### Deploy to Production
```bash
./deploy.sh
```

This will deploy all six Cloud Functions with:
- Firestore event triggers
- VPC connector for Redis access
- Automatic retries on failure
- Proper environment variables

### Deployed Functions
The deployment creates the following Cloud Functions:
- `feedEventsTrigger` - Monitors `feedEvents` collection
- `diaperEventsTrigger` - Monitors `diaperEvents` collection
- `sleepEventsTrigger` - Monitors `sleepEvents` collection
- `pumpingEventsTrigger` - Monitors `pumpingEvents` collection
- `childProfileTrigger` - Monitors `child_profile` collection
- `childQuestionnaireTrigger` - Monitors `child_questionnaire` collection

### Environment Variables
Configure these in `env.yaml`:
- `REDIS_HOST`: Redis cluster endpoint
- `REDIS_PORT`: Redis port (default: 6379)
- `REDIS_CLUSTER_MODE`: Set to "true" for Redis cluster
- `FIREBASE_PROJECT_ID`: Your GCP project ID
- Other API keys and configuration as needed

## Monitoring

Monitor function execution in Google Cloud Console:
```bash
gcloud functions logs read feedEventsTrigger --limit 50
gcloud functions logs read diaperEventsTrigger --limit 50
gcloud functions logs read sleepEventsTrigger --limit 50
gcloud functions logs read pumpingEventsTrigger --limit 50
gcloud functions logs read childProfileTrigger --limit 50
gcloud functions logs read childQuestionnaireTrigger --limit 50
```

## Error Handling

- Functions automatically retry on failure (configured in deployment)
- Redis connection errors are logged but don't prevent function completion
- API failures return empty data sets to prevent cache corruption
- All errors are logged to Cloud Logging for debugging

## Testing

### Test Individual Functions
To test a specific function after deployment:
```bash
# Check function logs
gcloud functions logs read [FUNCTION_NAME] --limit 50

# Example: Check childProfileTrigger logs
gcloud functions logs read childProfileTrigger --limit 50
```

### Verify Redis Data
After a Firestore document change, verify the data in Redis:
```javascript
// For activity data
const summaryData = await redisClient.get(`summary:${childId}`);
const dayLogData = await redisClient.get(`daylog:${childId}`);

// For profile data
const profileData = await redisClient.get(`profile:${childId}`);
```

## Security

- Cloud Functions use VPC connector for secure Redis access
- API authentication tokens are fetched per request
- No sensitive data is logged
- Service account follows principle of least privilege
- All functions run with automatic retry for reliability