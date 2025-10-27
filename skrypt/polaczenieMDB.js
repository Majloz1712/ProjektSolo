// skrypt/db_mongo.js
const { MongoClient } = require("mongodb");

const url = "mongodb://127.0.0.1:27017";
const dbName = "inzynierka";

async function connectMongo() {
  const client = await MongoClient.connect(url, { useUnifiedTopology: true });
  const db = client.db(dbName);

  console.log("✅ Połączono z MongoDB");

  // Tworzymy indeks unikalny na e-mailu
  try {
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
  } catch (_) {}

  return db;
}

module.exports = { connectMongo };

