// skrypt/polaczeniePG.js
const { Pool } = require("pg");

function getSafePassword() {
  const raw = process.env.PGPASSWORD;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  return s.length ? s : undefined; // puste -> brak hasła
}

const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  database: process.env.PGDATABASE || "inzynierka",
  // PRZEKAZUJ password TYLKO, jeśli JEST stringiem:
  ...(getSafePassword() !== undefined ? { password: getSafePassword() } : {}),
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

// szybki podgląd typu hasła (na czas debug)
console.log("PG password typeof:", typeof getSafePassword(), "value:", getSafePassword() ? "***set***" : "(none)");

module.exports = { pool };

