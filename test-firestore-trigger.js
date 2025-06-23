const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert('./firebase-key.json'),
  projectId: 'coddle-d9a2b'
});

const db = admin.firestore();

async function addTestDocument() {
  try {
    // Test data
    const testData = {
      parentId: 'test-parent-123',
      childId: 'test-child-456',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      testField: 'This is a test document',
      description: 'Testing Firestore to Redis sync'
    };

    // Add to testEvents collection (safe for testing)
    console.log('Adding test document to testEvents collection...');
    const docRef = await db.collection('testEvents').add(testData);
    console.log('Document added with ID:', docRef.id);
    console.log('Test data:', testData);
    
    console.log('\nThe Cloud Function should now trigger automatically.');
    console.log('Check the function logs with:');
    console.log('gcloud functions logs read testEventsTrigger --limit 50');
    
    console.log('\nTo verify Redis data was written, check for these keys:');
    console.log('- TEST_summary:test-child-456');
    console.log('- TEST_daylog:test-child-456');
    console.log('- TEST_parent:test-parent-123:child:test-child-456');
    
  } catch (error) {
    console.error('Error adding document:', error);
  } finally {
    // Wait a moment for the write to complete
    await new Promise(resolve => setTimeout(resolve, 2000));
    process.exit();
  }
}

addTestDocument();