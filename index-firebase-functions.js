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
    console.log('Raw event:', JSON.stringify(event));
    console.log('Context:', JSON.stringify(context));
    
    // Handle the event structure for Gen2 functions
    let documentData = {};
    let eventType = 'unknown';
    
    // Check if we have the proper event structure
    if (event.data) {
      // Get the document data from the event
      const afterExists = event.data.after && event.data.after.exists;
      const beforeExists = event.data.before && event.data.before.exists;
      
      if (afterExists) {
        documentData = event.data.after.data() || {};
      }
      
      // Determine event type
      eventType = !beforeExists ? 'created' : 
                  !afterExists ? 'deleted' : 'updated';
      
      // If document was deleted, skip processing
      if (!afterExists) {
        console.log('Document was deleted, skipping processing');
        return;
      }
    } else if (event.value) {
      // Alternative event structure
      documentData = event.value.fields || {};
      eventType = event.eventType || 'unknown';
    }
    
    console.log(`Processing ${eventType} event for collection: ${collectionName}`);
    console.log('Document path:', context?.params?.docId || 'unknown');
    console.log('Document data:', JSON.stringify(documentData));
    
    // Extract parentId and childId from document
    const parentId = documentData.parentId;
    const childId = documentData.childId;
    
    if (!parentId || !childId) {
      console.error('Missing parentId or childId in document');
      throw new Error('Missing required fields');
    }
    
    console.log(`Processing event for parent: ${parentId}, child: ${childId}`);
    
    // For test collection, let's use mock data instead of calling real APIs
    if (collectionName === 'testEvents') {
      console.log('TEST MODE: Using mock data instead of real API calls');
      
      // Mock authentication token
      const token = 'test-token-123';
      
      // Mock data
      const last7daySummary = {
        testMode: true,
        parentId: parentId,
        childId: childId,
        summary: 'This is test summary data for last 7 days',
        timestamp: new Date().toISOString()
      };
      
      const currentDayLogs = {
        testMode: true,
        sleep: [{id: 1, duration: '8 hours'}],
        feed: [{id: 1, amount: '6 oz'}],
        diaper: [{id: 1, type: 'wet'}],
        pumping: [{id: 1, amount: '4 oz'}]
      };
      
      // Store mock data in Redis with TEST prefix
      await updateRedisCache(parentId, childId, {
        last7daySummary,
        currentDayLogs,
        lastUpdated: new Date().toISOString(),
        eventSource: collectionName
      }, true); // true for test mode
      
    } else {
      // Production mode - call real APIs
      console.log('PRODUCTION MODE: Calling real APIs');
      
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
      }, false); // false for production mode
    }
    
    console.log('Event processed successfully');
  } catch (error) {
    console.error('Error processing event:', error);
    throw error;
  }
}

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
async function updateRedisCache(parentId, childId, data, isTestMode = false) {
  const client = await getRedisClient();
  
  try {
    // Add TEST_ prefix for test mode
    const prefix = isTestMode ? 'TEST_' : '';
    
    // Store summary data
    const summaryKey = `${prefix}summary:${childId}`;
    await client.setEx(summaryKey, 86400, JSON.stringify({
      data: data.last7daySummary,
      expiresAt: Date.now() + 86400000
    }));
    
    // Store day log data
    const dayLogKey = `${prefix}daylog:${childId}`;
    await client.setEx(dayLogKey, 1800, JSON.stringify({
      data: data.currentDayLogs,
      expiresAt: Date.now() + 1800000
    }));
    
    // Store combined data for parent-child pair
    const combinedKey = `${prefix}parent:${parentId}:child:${childId}`;
    await client.setEx(combinedKey, 3600, JSON.stringify(data));
    
    console.log(`Updated Redis cache for parent: ${parentId}, child: ${childId} (${isTestMode ? 'TEST MODE' : 'PRODUCTION MODE'})`);
    console.log(`Keys created: ${summaryKey}, ${dayLogKey}, ${combinedKey}`);
  } catch (error) {
    console.error('Redis update failed:', error);
    throw error;
  }
}

// Register TEST Firestore-triggered Cloud Function
exports.testEventsTrigger = onDocumentWritten({
  document: 'testEvents/{docId}',
  region: 'us-central1'
}, async (event, context) => {
  await processFirestoreEvent(event, context, 'testEvents');
});

// Register Production Firestore-triggered Cloud Functions
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