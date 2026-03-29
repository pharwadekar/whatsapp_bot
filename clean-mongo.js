require('dotenv').config();
const mongoose = require('mongoose');

async function cleanMongo() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected. Dropping collections...");
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const c of collections) {
     console.log(`Dropping ${c.name}...`);
     await mongoose.connection.db.dropCollection(c.name);
  }
  console.log("Done.");
  process.exit(0);
}
cleanMongo();