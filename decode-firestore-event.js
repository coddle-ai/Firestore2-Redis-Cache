// Helper to decode Firestore event data
function decodeFirestoreValue(buffer) {
  // This is a simplified decoder for Firestore protobuf data
  // In production, you'd use the proper protobuf library
  
  const data = {};
  
  // Convert buffer to string to see structure
  if (Buffer.isBuffer(buffer)) {
    const str = buffer.toString('utf8');
    console.log('Buffer as string (first 200 chars):', str.substring(0, 200));
    
    // Try to extract field values using regex patterns
    // This is a hacky approach - in production use proper protobuf decoding
    const fieldPattern = /(\w+Id)\x12[\x00-\xff]*(test-\w+-\d+)/g;
    let match;
    while ((match = fieldPattern.exec(str)) !== null) {
      data[match[1]] = match[2];
    }
  }
  
  return data;
}

module.exports = { decodeFirestoreValue };