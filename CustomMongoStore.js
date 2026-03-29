const fs = require('fs');
const path = require('path');
const MIN_VALID_SESSION_ZIP_BYTES = 1000;

class CustomMongoStore {
    constructor({ mongoose }) {
        if (!mongoose) throw new Error('A valid Mongoose instance is required for CustomMongoStore.');
        this.mongoose = mongoose;
        this._saveLocks = new Set();
    }

    // Helper to always get the exact same consistent name regardless of what RemoteAuth passes
    _getSessionName(options) {
        // options.session might be a full path or just the session name.
        // We only want the base name (e.g., 'RemoteAuth-bot-session')
        return path.basename(options.session);
    }

    async sessionExists(options) {
        const sessionName = this._getSessionName(options);
        const multiDeviceCollection = this.mongoose.connection.db.collection(`whatsapp-${sessionName}.files`);
        const hasExistingSession = await multiDeviceCollection.countDocuments({
            filename: `${sessionName}.zip`,
            length: { $gte: MIN_VALID_SESSION_ZIP_BYTES }
        });
        return !!hasExistingSession;
    }
    
    async save(options) {
        const sessionName = this._getSessionName(options);

        // Prevent overlapping save operations for the same session
        if (this._saveLocks.has(sessionName)) {
            console.log(`[MongoStore Log] ⏳ Save already in progress for ${sessionName}; skipping overlapping save.`);
            return;
        }
        this._saveLocks.add(sessionName);

        const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${sessionName}`
        });

        // RemoteAuth creates the zip at options.session + '.zip'
        const zipPath = `${options.session}.zip`;

        try {
            if (!fs.existsSync(zipPath)) {
                console.log(`[MongoStore Log] ⚠️ Zip path not found, skipping save: ${zipPath}`);
                return;
            }

            const stats = fs.statSync(zipPath);
            console.log(`\n[MongoStore Log] 📦 Preparing to upload session zip to MongoDB... Size: ${stats.size} bytes`);

            // Guard: skip known-bad tiny snapshots (e.g., 22 bytes) caused by fs race on Windows
            if (stats.size < MIN_VALID_SESSION_ZIP_BYTES) {
                console.log(`[MongoStore Log] ⚠️ Skipping tiny/invalid zip snapshot (${stats.size} bytes). Keeping previous good session.`);
                return;
            }

            await new Promise((resolve, reject) => {
                fs.createReadStream(zipPath)
                    .pipe(bucket.openUploadStream(`${sessionName}.zip`))
                    .on('error', err => {
                        console.log(`[MongoStore Log] ❌ ERRROR uploading to MongoDB:`, err);
                        reject(err)
                    })
                    .on('close', () => {
                        console.log(`[MongoStore Log] ☁️ SERVER UPLOAD 100% COMPLETE. Session safely stored in MongoDB Database.`);
                        resolve();
                    });
            });

            options.bucket = bucket;
            options.sessionName = sessionName; // inject for deletePrevious
            await this.#deletePrevious(options);
        } finally {
            this._saveLocks.delete(sessionName);
        }
    }

    async extract(options) {
        const sessionName = this._getSessionName(options);
        const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${sessionName}`
        });

        const candidates = await bucket.find({ filename: `${sessionName}.zip` }).toArray();
        const validCandidates = candidates
            .filter(doc => (doc.length || 0) >= MIN_VALID_SESSION_ZIP_BYTES)
            .sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime());

        if (!validCandidates.length) {
            throw new Error(`No valid session zip found in MongoDB for ${sessionName}.`);
        }

        const selected = validCandidates[0];
        console.log(`[MongoStore Log] 📥 Extracting session ${sessionName} from MongoDB (size: ${selected.length} bytes, uploadDate: ${selected.uploadDate}).`);

        return new Promise((resolve, reject) => {
            bucket.openDownloadStream(selected._id)
                .pipe(fs.createWriteStream(options.path))
                .on('error', err => {
                    console.log(`[MongoStore Log] ❌ Failed extracting session ${sessionName}:`, err?.message || err);
                    reject(err)
                })
                .on('close', () => {
                    console.log(`[MongoStore Log] ✅ Extracted session ${sessionName} from MongoDB.`);
                    resolve();
                });
        });
    }

    async delete(options) {
        const sessionName = this._getSessionName(options);
        const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${sessionName}`
        });

        const documents = await bucket.find({
            filename: `${sessionName}.zip`
        }).toArray();

        for (const doc of documents) {
            try {
                await bucket.delete(doc._id);
            } catch (err) {
                if ((err?.message || '').includes('File not found for id')) {
                    // Benign race: file already deleted by overlapping operation
                    continue;
                }
                throw err;
            }
        }
    }

    async #deletePrevious(options) {
        const documents = await options.bucket.find({
            filename: `${options.sessionName}.zip`
        }).toArray();

        if (documents.length > 1) {
            const oldSession = documents.reduce((a, b) => a.uploadDate < b.uploadDate ? a : b);
            try {
                return await options.bucket.delete(oldSession._id);
            } catch (err) {
                if ((err?.message || '').includes('File not found for id')) {
                    // Benign race condition during cleanup
                    return;
                }
                throw err;
            }
        }
    }
}

module.exports = { CustomMongoStore };