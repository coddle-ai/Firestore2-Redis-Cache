const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const redis = require('redis');
const axios = require('axios');
const { decodeFirestoreEvent } = require('./firestore-decoder-simple');

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
    
    // Log the raw event structure for debugging
    console.log('Raw CloudEvent:', {
      type: cloudEvent.type,
      subject: cloudEvent.subject,
      dataContentType: cloudEvent.dataContentType,
      dataIsBuffer: Buffer.isBuffer(eventData),
      dataType: typeof eventData
    });
    
    // If data is a Buffer, decode it using our Firestore decoder
    if (Buffer.isBuffer(eventData)) {
      console.log('Event data is a Buffer, attempting to decode...');
      try {
        eventData = decodeFirestoreEvent(eventData);
        console.log('Decoded event data successfully');
      } catch (e) {
        console.error('Failed to decode Firestore event:', e.message);
        // Try to parse as JSON as fallback
        try {
          const dataStr = eventData.toString('utf8');
          eventData = JSON.parse(dataStr);
          console.log('Parsed as JSON successfully');
        } catch (e2) {
          console.error('Failed to parse as JSON:', e2.message);
          throw new Error('Unable to decode event data');
        }
      }
    } else if (typeof eventData === 'object' && eventData !== null) {
      // Check if data is already in the expected format
      console.log('Event data is an object, checking structure...');
      
      // Check for direct field access (non-protobuf format)
      if (eventData.parentId && eventData.childId) {
        console.log('Found direct parentId and childId fields');
        eventData = {
          value: {
            fields: {
              parentId: { stringValue: eventData.parentId },
              childId: { stringValue: eventData.childId }
            }
          }
        };
      }
    }
    
    console.log('Parsed event data:', JSON.stringify(eventData).substring(0, 500));
    
    // Log the full structure for debugging
    console.log('Full CloudEvent structure:', {
      type: cloudEvent.type,
      subject: cloudEvent.subject,
      dataKeys: eventData ? Object.keys(eventData) : 'No data',
      hasValue: eventData && eventData.value ? 'yes' : 'no',
      hasFields: eventData && eventData.value && eventData.value.fields ? 'yes' : 'no'
    });
    
    // Extract document data from the CloudEvent
    let documentData = {};
    let eventType = 'unknown';
    
    if (eventData && eventData.value && eventData.value.fields) {
      // Document data is in value.fields
      const fields = eventData.value.fields;
      console.log('Available fields:', Object.keys(fields));
      
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
        } else if (value.mapValue && value.mapValue.fields) {
          // Handle nested maps
          documentData[key] = {};
          for (const [nestedKey, nestedValue] of Object.entries(value.mapValue.fields)) {
            if (nestedValue.stringValue !== undefined) {
              documentData[key][nestedKey] = nestedValue.stringValue;
            }
          }
        } else if (value.arrayValue && value.arrayValue.values) {
          // Handle arrays
          documentData[key] = value.arrayValue.values.map(v => {
            if (v.stringValue !== undefined) return v.stringValue;
            if (v.integerValue !== undefined) return parseInt(v.integerValue);
            return v;
          });
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
    } else {
      console.log('WARNING: No value.fields found in event data');
      console.log('Event data structure:', JSON.stringify(eventData, null, 2));
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
    
    // childId is mandatory
    if (!childId) {
      const errorDetails = {
        hasChildId: !!childId,
        childIdValue: childId || 'NOT_FOUND',
        documentDataKeys: Object.keys(documentData),
        documentData: JSON.stringify(documentData).substring(0, 200),
        collectionName: collectionName,
        eventSubject: cloudEvent.subject,
        documentPath: cloudEvent.subject ? cloudEvent.subject.split('/').slice(-1)[0] : 'unknown'
      };
      
      console.error('CRITICAL: Missing required childId in document:', errorDetails);
      console.error(`Document ${errorDetails.documentPath} in collection ${collectionName} is missing required childId!`);
      
      throw new Error(`Missing required field childId. Document: ${errorDetails.documentPath}`);
    }
    
    // Log if parentId is missing (but don't fail)
    if (!parentId) {
      console.warn(`Document ${cloudEvent.subject} has no parentId - will skip authentication and use limited processing`);
    }
    
    console.log(`Processing event for parent: ${parentId || 'NONE'}, child: ${childId}`);
    
    // Get authentication token only if parentId is available
    let token = null;
    if (parentId) {
      try {
        token = await getAuthToken(parentId);
      } catch (error) {
        console.error(`Failed to get auth token for parentId ${parentId}:`, error.message);
        // Continue without token for documents without parentId
        console.warn('Continuing without authentication token');
      }
    } else {
      console.warn('No parentId available - skipping authentication');
    }
    
    // Check if this is a profile-related collection
    if (collectionName === 'child_profile' || collectionName === 'child_questionnaire') {
      // For profile collections, we need parentId for authentication
      if (!parentId || !token) {
        console.error('Cannot process profile collection without parentId for authentication');
        throw new Error('Profile collections require parentId for authentication');
      }
      
      // Fetch child profile data
      const childProfile = await getChildProfile(parentId, childId, token);
      
      // Store profile data in Redis
      await updateProfileRedisCache(parentId, childId, {
        profile: childProfile,
        lastUpdated: new Date().toISOString(),
        eventSource: collectionName
      });
    } else {
      // For activity collections
      if (parentId && token) {
        // Full processing with authentication
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
      } else {
        // Limited processing without authentication - just cache the event data
        console.warn('Limited processing mode - caching event data only');
        
        // Store minimal data in Redis (using childId only)
        await updateRedisCache(null, childId, {
          eventData: documentData,
          lastUpdated: new Date().toISOString(),
          eventSource: collectionName,
          processingMode: 'limited_no_auth'
        });
      }
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
    // If we have full data (with authentication)
    if (data.last7daySummary && data.currentDayLogs) {
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
    }
    
    // Store combined data for parent-child pair only if parentId exists
    if (parentId) {
      const combinedKey = `parent:${parentId}:child:${childId}`;
      await client.setEx(combinedKey, 3600, JSON.stringify(data));
    } else {
      // For documents without parentId, store under a special key
      const limitedKey = `limited:child:${childId}:${data.eventSource}`;
      await client.setEx(limitedKey, 3600, JSON.stringify(data));
    }
    
    console.log(`Updated Redis cache for parent: ${parentId || 'NONE'}, child: ${childId}`);
    
    // Log created keys
    const keysCreated = [];
    if (data.last7daySummary) keysCreated.push(`summary:${childId}`);
    if (data.currentDayLogs) keysCreated.push(`daylog:${childId}`);
    if (parentId) {
      keysCreated.push(`parent:${parentId}:child:${childId}`);
    } else {
      keysCreated.push(`limited:child:${childId}:${data.eventSource}`);
    }
    console.log(`Keys created: ${keysCreated.join(', ')}`);
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

// Enhanced processFirestoreEvent with smart retry logic
async function processFirestoreEventWithRetryLogic(cloudEvent, collectionName) {
  try {
    await processFirestoreEvent(cloudEvent, collectionName);
  } catch (error) {
    console.error('Error processing event:', error);
    
    // Determine if this is a recoverable error
    const isRecoverable = shouldRetry(error, cloudEvent, collectionName);
    
    if (!isRecoverable) {
      // Log the error but acknowledge the message to prevent infinite retries
      console.error('Non-recoverable error - acknowledging message to prevent retries');
      console.error('Error details:', {
        error: error.message,
        collection: collectionName,
        subject: cloudEvent.subject,
        eventId: cloudEvent.id
      });
      
      // Store failed event for later analysis
      try {
        await logFailedEvent(cloudEvent, collectionName, error);
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }
      
      // Return successfully to acknowledge the message
      return;
    }
    
    // For recoverable errors, re-throw to trigger retry
    console.error('Recoverable error - will retry');
    throw error;
  }
}

// Determine if an error should trigger a retry
function shouldRetry(error, cloudEvent, collectionName) {
  const errorMessage = error.message || '';
  
  // Don't retry for validation errors
  if (errorMessage.includes('Missing required field')) {
    console.log('Non-recoverable: Missing required field');
    return false;
  }
  
  // Don't retry for test data
  if (errorMessage.includes('12345') || 
      errorMessage.includes('test') ||
      (cloudEvent.subject && cloudEvent.subject.includes('test'))) {
    console.log('Non-recoverable: Test data detected');
    return false;
  }
  
  // Don't retry for 404 errors (child not found)
  if (error.response && error.response.status === 404) {
    console.log('Non-recoverable: 404 Not Found');
    return false;
  }
  
  // Don't retry for authentication errors
  if (error.response && error.response.status === 401) {
    console.log('Non-recoverable: 401 Authentication error');
    return false;
  }
  
  // Don't retry for bad request errors
  if (error.response && error.response.status === 400) {
    console.log('Non-recoverable: 400 Bad Request');
    return false;
  }
  
  // Retry for temporary errors
  if (error.code === 'ECONNREFUSED' || 
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNRESET') {
    console.log('Recoverable: Network error');
    return true;
  }
  
  // Retry for 5xx server errors
  if (error.response && error.response.status >= 500) {
    console.log('Recoverable: Server error');
    return true;
  }
  
  // Default: don't retry for unknown errors
  console.log('Non-recoverable: Unknown error type');
  return false;
}

// Log failed events for analysis
async function logFailedEvent(cloudEvent, collectionName, error) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    
    const db = admin.firestore();
    
    const failureDoc = {
      eventId: cloudEvent.id,
      eventType: cloudEvent.type,
      subject: cloudEvent.subject,
      collection: collectionName,
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: typeof error.response.data === 'string' 
            ? error.response.data.substring(0, 1000) 
            : JSON.stringify(error.response.data).substring(0, 1000)
        } : null
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      acknowledged: true,
      reason: 'non_recoverable_error'
    };
    
    await db.collection('processing_failures').add(failureDoc);
    console.log('Failed event logged to Firestore');
  } catch (logError) {
    console.error('Could not log to Firestore:', logError);
    // Don't throw - we still want to acknowledge the message
  }
}

functions.cloudEvent('feedEventsTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'feedEvents');
});

functions.cloudEvent('diaperEventsTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'diaperEvents');
});

functions.cloudEvent('sleepEventsTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'sleepEvents');
});

functions.cloudEvent('pumpingEventsTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'pumpingEvents');
});

functions.cloudEvent('childProfileTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'child_profile');
});

functions.cloudEvent('childQuestionnaireTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'child_questionnaire');
});

functions.cloudEvent('testEventsTrigger', async (cloudEvent) => {
  await processFirestoreEventWithRetryLogic(cloudEvent, 'testEvents');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
});