const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const redis = require('redis');
const axios = require('axios');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert('./firebase-key.json'),
  projectId: process.env.FIREBASE_PROJECT_ID
});

// Initialize Redis client
let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    // Check if Redis is running in cluster mode
    const isCluster = process.env.REDIS_CLUSTER_MODE === 'true';
    
    if (isCluster) {
      // For Redis Cluster
      redisClient = redis.createCluster({
        rootNodes: [
          {
            socket: {
              host: process.env.REDIS_HOST,
              port: parseInt(process.env.REDIS_PORT)
            }
          }
        ],
        defaults: {
          socket: {
            connectTimeout: 10000
          }
        }
      });
    } else {
      // For standalone Redis
      redisClient = redis.createClient({
        socket: {
          host: process.env.REDIS_HOST,
          port: parseInt(process.env.REDIS_PORT)
        }
      });
    }
    
    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
    
    await redisClient.connect();
    console.log('Connected to Redis successfully');
  }
  
  return redisClient;
}

// Helper function to process Firestore events
async function processFirestoreEvent(cloudEvent, collectionName) {
  try {
    console.log('Processing event for collection:', collectionName);
    console.log('Event type:', cloudEvent.type);
    console.log('Event subject:', cloudEvent.subject);
    
    // For Firestore events in Cloud Functions, the data might be a Buffer
    let eventData = cloudEvent.data;
    
    // If data is a Buffer, try to parse it as JSON
    if (Buffer.isBuffer(eventData)) {
      console.log('Event data is a Buffer, attempting to parse...');
      try {
        // First try to convert to string and parse as JSON
        const dataStr = eventData.toString('utf8');
        eventData = JSON.parse(dataStr);
      } catch (e) {
        console.log('Failed to parse as JSON, data might be protobuf encoded');
        // For now, we'll extract values manually
        const dataStr = eventData.toString('utf8');
        
        // Try to extract parentId and childId from the buffer string
        const parentIdMatch = dataStr.match(/parentId.*?(test-parent-\d+)/);
        const childIdMatch = dataStr.match(/childId.*?(test-child-\d+)/);
        
        if (parentIdMatch && childIdMatch) {
          eventData = {
            value: {
              fields: {
                parentId: { stringValue: parentIdMatch[1] },
                childId: { stringValue: childIdMatch[1] }
              }
            }
          };
        }
      }
    }
    
    console.log('Parsed event data:', JSON.stringify(eventData).substring(0, 500));
    
    // Extract document data from the CloudEvent
    let documentData = {};
    let eventType = 'unknown';
    
    if (eventData && eventData.value && eventData.value.fields) {
      // Document data is in value.fields
      const fields = eventData.value.fields;
      
      // Convert Firestore fields to regular JS object
      documentData = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value.stringValue !== undefined) {
          documentData[key] = value.stringValue;
        } else if (value.integerValue !== undefined) {
          documentData[key] = parseInt(value.integerValue);
        } else if (value.doubleValue !== undefined) {
          documentData[key] = value.doubleValue;
        } else if (value.booleanValue !== undefined) {
          documentData[key] = value.booleanValue;
        } else if (value.timestampValue !== undefined) {
          documentData[key] = new Date(value.timestampValue);
        }
      }
      
      // Determine event type from oldValue and value
      if (!eventData.oldValue || !eventData.oldValue.name) {
        eventType = 'created';
      } else if (!eventData.value || !eventData.value.name) {
        eventType = 'deleted';
      } else {
        eventType = 'updated';
      }
    }
    
    console.log(`Event type: ${eventType}`);
    console.log('Document data:', JSON.stringify(documentData));
    
    // If document was deleted, skip processing
    if (eventType === 'deleted') {
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
    
    // Check if this is a profile-related collection
    if (collectionName === 'child_profile' || collectionName === 'child_questionnaire') {
      // For profile collections, fetch child profile data
      const childProfile = await getChildProfile(parentId, childId, token);
      
      // Store profile data in Redis
      await updateProfileRedisCache(parentId, childId, {
        profile: childProfile,
        lastUpdated: new Date().toISOString(),
        eventSource: collectionName
      });
    } else {
      // For activity collections, fetch summary and logs
      const [last7daySummary, currentDayLogs] = await Promise.all([
        getLast7daySummary(parentId, childId, token),
        getCurrentDayLogs(parentId, childId, token)
      ]);
      
      // Store activity data in Redis
      await updateRedisCache(parentId, childId, {
        last7daySummary,
        currentDayLogs,
        lastUpdated: new Date().toISOString(),
        eventSource: collectionName
      });
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

// Get child profile
async function getChildProfile(parentId, childId, token) {
  try {
    console.log(`Getting child profile for parent: ${parentId}, child: ${childId}`);
    
    const response = await axios.get(
      `https://api-3sfdwjc2da-uc.a.run.app/child-profile/${childId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    // Validate required fields
    const requiredFields = ['name', 'dateOfBirth', 'gender'];
    const missingFields = requiredFields.filter(
      field => response.data[field] === undefined
    );
    
    if (missingFields.length > 0) {
      throw new Error(`API response missing required fields: ${missingFields.join(', ')}`);
    }
    
    console.log('Successfully retrieved child profile');
    return response.data;
  } catch (error) {
    console.error('Error fetching child profile:', error.message);
    throw error;
  }
}

// Update Redis cache with activity data
async function updateRedisCache(parentId, childId, data) {
  const client = await getRedisClient();
  
  try {
    // Store summary data (24 hour TTL)
    const summaryKey = `summary:${childId}`;
    await client.setEx(summaryKey, 86400, JSON.stringify({
      data: data.last7daySummary,
      expiresAt: Date.now() + 86400000
    }));
    
    // Store day log data (30 minute TTL)
    const dayLogKey = `daylog:${childId}`;
    await client.setEx(dayLogKey, 1800, JSON.stringify({
      data: data.currentDayLogs,
      expiresAt: Date.now() + 1800000
    }));
    
    // Store combined data for parent-child pair (1 hour TTL)
    const combinedKey = `parent:${parentId}:child:${childId}`;
    await client.setEx(combinedKey, 3600, JSON.stringify(data));
    
    console.log(`Updated Redis cache for parent: ${parentId}, child: ${childId}`);
    console.log(`Keys created: ${summaryKey}, ${dayLogKey}, ${combinedKey}`);
  } catch (error) {
    console.error('Redis update failed:', error);
    throw error;
  }
}

// Update Redis cache with profile data
async function updateProfileRedisCache(parentId, childId, data) {
  const client = await getRedisClient();
  
  try {
    // Store child profile data (24 hour TTL)
    const profileKey = `profile:${childId}`;
    await client.setEx(profileKey, 86400, JSON.stringify({
      data: data.profile,
      expiresAt: Date.now() + 86400000
    }));
    
    // Store profile data with parent-child key (24 hour TTL)
    const parentChildProfileKey = `profile:parent:${parentId}:child:${childId}`;
    await client.setEx(parentChildProfileKey, 86400, JSON.stringify(data));
    
    console.log(`Updated Redis profile cache for parent: ${parentId}, child: ${childId}`);
    console.log(`Keys created: ${profileKey}, ${parentChildProfileKey}`);
  } catch (error) {
    console.error('Redis profile update failed:', error);
    throw error;
  }
}

// Register Cloud Functions using the framework
functions.cloudEvent('feedEventsTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'feedEvents');
});

functions.cloudEvent('diaperEventsTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'diaperEvents');
});

functions.cloudEvent('sleepEventsTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'sleepEvents');
});

functions.cloudEvent('pumpingEventsTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'pumpingEvents');
});

functions.cloudEvent('childProfileTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'child_profile');
});

functions.cloudEvent('childQuestionnaireTrigger', async (cloudEvent) => {
  await processFirestoreEvent(cloudEvent, 'child_questionnaire');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
});