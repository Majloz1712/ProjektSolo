// skrypt/polaczenieMDB.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGO_DB || 'inzynierka';

// Wspólny klient dla całej aplikacji (serwer + agent)
const mongoClient = new MongoClient(MONGO_URI);

// Cache db po pierwszym połączeniu
let dbCache = null;

/**
 * Używane przez serwerStart.js
 * Łączy (jeśli potrzeba) i zwraca instancję DB.
 */
async function connectMongo() {
  if (!dbCache) {
    await mongoClient.connect();
    dbCache = mongoClient.db(DB_NAME);
  }
  return dbCache;
}

/**
 * Opcjonalny helper – jeśli już połączeni, zwróci db.
 */
function getDb() {
  return dbCache || mongoClient.db(DB_NAME);
}

module.exports = { mongoClient, connectMongo, getDb };

