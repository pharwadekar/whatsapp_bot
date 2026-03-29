require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

(async () => {
    console.log("🚀 Starting manual session upload to MongoDB...");
    
    if (!process.env.MONGODB_URI) {
        console.error("❌ MONGODB_URI missing from .env");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
    console.log("✅ Connected to MongoDB!");

    // Construct the explicit bucket used by RemoteAuth
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
        bucketName: 'whatsapp-RemoteAuth-bot-session' // Corrected
    });

    const sessionName = 'RemoteAuth-bot-session';
    const sourceDir = path.join(__dirname, '.wwebjs_auth', 'session-bot-session');
    
    if (!fs.existsSync(sourceDir)) {
        console.error(`❌ Could not find session directory at ${sourceDir}.`);
        console.log("Did you run the bot locally with LocalAuth first and scan the QR?");
        process.exit(1);
    }

    // 1. Delete any old session zipped files in DB
    console.log("🗑️ Clearing old session files from MongoDB...");
    const files = await bucket.find({ filename: `${sessionName}.zip` }).toArray();
    for (const file of files) {
        await bucket.delete(file._id);
    }

    // 2. Zip the directory and pipe directly to MongoDB (bypassing CustomMongoStore)
    console.log(`📦 Zipping ${sourceDir} and uploading directly to MongoDB GridFS...`);
    
    const uploadStream = bucket.openUploadStream(`${sessionName}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });

    uploadStream.on('error', (err) => {
        console.error("❌ Error uploading to MongoDB:", err);
        process.exit(1);
    });

    uploadStream.on('finish', () => {
        console.log(`✅ SUCCESS! the session was uploaded securely! (Length: ${uploadStream.length} bytes)`);
        console.log("🎉 You can now switch index.js back to RemoteAuth and deploy to Render!");
        process.exit(0);
    });

    archive.on('error', (err) => {
        console.error("❌ Archiver Error:", err);
        process.exit(1);
    });

    // Pipe archive output straight into the MongoDB upload stream
    archive.pipe(uploadStream);

    // Append files from a sub-directory, putting its contents at the root of archive
    archive.directory(sourceDir, false);

    // Finalize the archive (this triggers the upload stream to finish)
    await archive.finalize();

})();
