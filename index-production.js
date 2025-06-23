const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const redis = require('redis');
const axios = require('axios');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert('./firebase-key.json'),
  projectId: process.env.FIREBASE_PROJECT_ID
});

// Initialize Redis client with cluster mode
let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT)
      }
    });
    
    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
    
    await redisClient.connect();
  }
  
  return redisClient;
}

// Helper function to process Firestore events
async function processFirestoreEvent(event, context, collectionName) {
  try {
    // Get the document data from the event
    const documentData = event.data.after.data() || {};
    
    // Determine event type
    const eventType = !event.data.before.exists ? 'created' : 
                     !event.data.after.exists ? 'deleted' : 'updated';
    
    console.log(`Processing ${eventType} event for collection: ${collectionName}`);
    console.log('Document path:', context.params.docId);
    
    // If document was deleted, skip processing
    if (!event.data.after.exists) {
      console.log('Document was deleted, skipping processing');
      return;
    }
    
    // Extract parentId and childId from document
    const parentId = documentData.parentId;
    const childId = documentData.childId;
    
    if (!parentId || !childId) {
      console.error('Missing parentId or childId in document');
      throw new Error('Missing required fields');
    }
    
    console.log(`Processing event for parent: ${parentId}, child: ${childId}`);
    
    // Get authentication token
    const token = await getAuthToken(parentId);
    
    // Fetch last 7 days summary and current day logs
    const [last7daySummary, currentDayLogs] = await Promise.all([
      getLast7daySummary(parentId, childId, token),
      getCurrentDayLogs(parentId, childId, token)
    ]);
    
    // Store both datasets in Redis
    await updateRedisCache(parentId, childId, {
      last7daySummary,
      currentDayLogs,
      lastUpdated: new Date().toISOString(),
      eventSource: collectionName
    });
    
    console.log('Event processed successfully');
  } catch (error) {
    console.error('Error processing event:', error);
    throw error;
  }
}

// Note: extractFieldValue is no longer needed with native Firestore triggers
// as the data comes in standard JavaScript format

// Get authentication token from API
async function getAuthToken(parentId) {
  try {
    console.log(`Getting authentication token for parent: ${parentId}`);
    
    const response = await axios.get(
      `https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/token/${parentId}`,
      {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.data || !response.data.token) {
      throw new Error('API response missing token field');
    }
    
    console.log('Authentication token retrieved successfully');
    return response.data.token;
  } catch (error) {
    console.error('Failed to get authentication token:', error.message);
    throw error;
  }
}

// Get last 7 days summary
async function getLast7daySummary(parentId, childId, token) {
  try {
    console.log(`Getting 7-day summary for parent: ${parentId}, child: ${childId}`);
    
    const response = await axios.post(
      'https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/summary',
      {
        childId,
        parentId,
        timeZone: 'America/Los_Angeles',
        flType: 'ML'
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log('Successfully retrieved 7-day summary');
    return response.data;
  } catch (error) {
    console.error('Error fetching 7-day summary:', error.message);
    return [];
  }
}

// Get current day logs
async function getCurrentDayLogs(parentId, childId, token) {
  try {
    console.log(`Getting current day logs for parent: ${parentId}, child: ${childId}`);
    
    const response = await axios.post(
      'https://api-3sfdwjc2da-uc.a.run.app/chatAssistant/current-logs',
      {
        childId,
        timeZone: 'America/Los_Angeles'
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log('Successfully retrieved current day logs');
    return response.data;
  } catch (error) {
    console.error('Error fetching current day logs:', error.message);
    return {
      sleep: [],
      feed: [],
      diaper: [],
      pumping: []
    };
  }
}

// Update Redis cache with the data
async function updateRedisCache(parentId, childId, data) {
  const client = await getRedisClient();
  
  try {
    // Store summary data
    const summaryKey = `summary:${childId}`;
    await client.setEx(summaryKey, 86400, JSON.stringify({
      data: data.last7daySummary,
      expiresAt: Date.now() + 86400000
    }));
    
    // Store day log data
    const dayLogKey = `daylog:${childId}`;
    await client.setEx(dayLogKey, 1800, JSON.stringify({
      data: data.currentDayLogs,
      expiresAt: Date.now() + 1800000
    }));
    
    // Store combined data for parent-child pair
    const combinedKey = `parent:${parentId}:child:${childId}`;
    await client.setEx(combinedKey, 3600, JSON.stringify(data));
    
    console.log(`Updated Redis cache for parent: ${parentId}, child: ${childId}`);
  } catch (error) {
    console.error('Redis update failed:', error);
    throw error;
  }
}

// Register Firestore-triggered Cloud Functions for each collection
exports.feedEventsTrigger = onDocumentWritten({
  document: 'feedEvents/{docId}',
  region: 'us-central1'
}, async (event, context) => {
  await processFirestoreEvent(event, context, 'feedEvents');
});

exports.diaperEventsTrigger = onDocumentWritten({
  document: 'diaperEvents/{docId}',
  region: 'us-central1'
}, async (event, context) => {
  await processFirestoreEvent(event, context, 'diaperEvents');
});

exports.sleepEventsTrigger = onDocumentWritten({
  document: 'sleepEvents/{docId}',
  region: 'us-central1'
}, async (event, context) => {
  await processFirestoreEvent(event, context, 'sleepEvents');
});

exports.pumpingEventsTrigger = onDocumentWritten({
  document: 'pumpingEvents/{docId}',
  region: 'us-central1'
}, async (event, context) => {
  await processFirestoreEvent(event, context, 'pumpingEvents');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
});