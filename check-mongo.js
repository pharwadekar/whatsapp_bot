require('dotenv').config();
const mongoose = require('mongoose');
const MIN_VALID_SESSION_ZIP_BYTES = 1000;

async function checkDb() {
  if (!process.env.MONGODB_URI) {
    console.error("No MONGODB_URI found in .env");
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB successfully!");
    
    const db = mongoose.connection.db;
    
    // List all collections in the database
    const collections = await db.listCollections().toArray();
    console.log(`\nFound ${collections.length} collections in the database:`);
    
    let authFound = false;
    let hasValidSessionZip = false;

    // Iterate and check document counts
    for (const c of collections) {
      const count = await db.collection(c.name).countDocuments();
      console.log(`- 📂 Collection '${c.name}' contains ${count} documents.`);
      
      if (count > 0) {
        const sample = await db.collection(c.name).findOne();
        console.log(`  Sample keys stored: [${Object.keys(sample).join(", ")}]`);
        
        if (sample.session || c.name.toLowerCase().includes('auth') || c.name.toLowerCase().includes('session')) {
          authFound = true;
        }

        // Special handling for GridFS .files collection, where actual zip length lives
        if (c.name.endsWith('.files')) {
          const files = await db.collection(c.name)
            .find({ filename: /RemoteAuth.*\.zip$/i })
            .sort({ uploadDate: -1 })
            .toArray();

          if (files.length) {
            console.log(`  RemoteAuth zip versions found: ${files.length}`);
            files.slice(0, 5).forEach((f, idx) => {
              const valid = (f.length || 0) >= MIN_VALID_SESSION_ZIP_BYTES;
              if (valid) hasValidSessionZip = true;
              console.log(`   ${idx + 1}. ${f.filename} | size=${f.length} bytes | uploadDate=${f.uploadDate} | ${valid ? 'VALID' : 'INVALID/TINY'}`);
            });
          }
        }
      }
    }

    if (hasValidSessionZip) {
      console.log("\n🎉 A valid RemoteAuth session zip exists in MongoDB.");
    } else if (authFound) {
      console.log("\n⚠️ RemoteAuth collections exist, but no valid zip found (likely tiny/corrupt backup). QR fallback is expected until a valid session is uploaded.");
    } else {
      console.log("\n⚠️ No auth session data found yet. Either it is still connecting on WhatsApp or hasn't synced yet.");
    }

  } catch (err) {
    console.error("❌ Error checking MongoDB:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected.");
  }
}

checkDb();
