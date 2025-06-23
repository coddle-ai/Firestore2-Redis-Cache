const redis = require('redis');

async function checkRedisData() {
  let client;
  
  try {
    // Create Redis client
    client = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || '10.128.0.2',
        port: parseInt(process.env.REDIS_PORT || '6379')
      }
    });
    
    client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
    
    await client.connect();
    console.log('Connected to Redis');
    
    // Check for test keys
    const testKeys = [
      'TEST_summary:test-child-456',
      'TEST_daylog:test-child-456',
      'TEST_parent:test-parent-123:child:test-child-456'
    ];
    
    console.log('\nChecking for test keys in Redis:');
    console.log('================================');
    
    for (const key of testKeys) {
      const exists = await client.exists(key);
      if (exists) {
        const value = await client.get(key);
        const ttl = await client.ttl(key);
        console.log(`\nKey: ${key}`);
        console.log(`Exists: YES`);
        console.log(`TTL: ${ttl} seconds`);
        console.log(`Value:`, JSON.parse(value));
      } else {
        console.log(`\nKey: ${key}`);
        console.log(`Exists: NO`);
      }
    }
    
    // Also check for any TEST_ prefixed keys
    console.log('\n\nSearching for all TEST_ prefixed keys:');
    console.log('======================================');
    const keys = await client.keys('TEST_*');
    console.log(`Found ${keys.length} TEST_ keys:`, keys);
    
  } catch (error) {
    console.error('Error checking Redis:', error);
  } finally {
    if (client) {
      await client.quit();
      console.log('\nDisconnected from Redis');
    }
  }
}

// Load environment variables from env.yaml manually if needed
const fs = require('fs');
const yaml = require('js-yaml');

try {
  const envContent = fs.readFileSync('./env.yaml', 'utf8');
  const envVars = yaml.load(envContent);
  Object.assign(process.env, envVars);
} catch (e) {
  console.log('Could not load env.yaml, using defaults');
}

checkRedisData();