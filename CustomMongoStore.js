const fs = require('fs');
const path = require('path');

class CustomMongoStore {
    constructor({ mongoose }) {
        if (!mongoose) throw new Error('A valid Mongoose instance is required for CustomMongoStore.');
        this.mongoose = mongoose;
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
        const hasExistingSession = await multiDeviceCollection.countDocuments();
        return !!hasExistingSession;
    }
    
    async save(options) {
        const sessionName = this._getSessionName(options);
        const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${sessionName}`
        });

        // RemoteAuth creates the zip at options.session + '.zip'
        const zipPath = `${options.session}.zip`;

        if (fs.existsSync(zipPath)) {
            const stats = fs.statSync(zipPath);
            console.log(`\n[MongoStore Log] 📦 Preparing to upload session zip to MongoDB... Size: ${stats.size} bytes`);
            if (stats.size < 1000) {
                console.log(`[MongoStore Log] ⚠️ WARNING: Zip file is suspiciously small (${stats.size} bytes). Chrome may not have flushed data to disk yet!`);
            }
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
    }

    async extract(options) {
        const sessionName = this._getSessionName(options);
        const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${sessionName}`
        });

        return new Promise((resolve, reject) => {
            bucket.openDownloadStreamByName(`${sessionName}.zip`)
                .pipe(fs.createWriteStream(options.path))
                .on('error', err => reject(err))
                .on('close', () => resolve());
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

        documents.map(async doc => {
            return bucket.delete(doc._id);
        });
    }

    async #deletePrevious(options) {
        const documents = await options.bucket.find({
            filename: `${options.sessionName}.zip`
        }).toArray();

        if (documents.length > 1) {
            const oldSession = documents.reduce((a, b) => a.uploadDate < b.uploadDate ? a : b);
            return options.bucket.delete(oldSession._id);
        }
    }
}

module.exports = { CustomMongoStore };