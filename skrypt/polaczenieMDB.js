import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'inzynierka';

export const mongoClient = new MongoClient(MONGO_URI);

let dbCache = null;

export async function connectMongo() {
  if (!dbCache) {
    await mongoClient.connect();
    dbCache = mongoClient.db(DB_NAME);
  }
  return dbCache;
}

export function getDb() {
  return dbCache || mongoClient.db(DB_NAME);
}

export default mongoClient;
