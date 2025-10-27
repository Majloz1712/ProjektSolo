// skrypt/serwerStart.js
require("dotenv").config();
console.log("🔍 JWT_SECRET loaded:", !!process.env.JWT_SECRET ? "✅ OK" : "❌ MISSING");
const express = require("express");
const path = require("path");
const { pool } = require("./polaczeniePG");
const { connectMongo } = require("./polaczenieMDB");
const authRoutes = require("./routes/auth");
const monitoryRoutes = require("./routes/monitory");
const app = express();
const PORT = 3001;

// pokaż, JAKI moduł puli faktycznie się ładuje
console.log("ℹ️ polaczeniePG path:", require.resolve("./polaczeniePG"));

// Jednorazowy sanity-check połączenia i widocznych tabel
(async () => {
  const cfg = {
    host: pool.options.host,
    port: pool.options.port,
    user: pool.options.user,
    database: pool.options.database,
  };
  console.log("ℹ️ Pool options:", cfg);

  const { rows } = await pool.query(`
    SELECT current_database() AS db,
           current_user AS usr,
           inet_server_addr()::text AS host,
           inet_server_port() AS port,
           (SELECT setting FROM pg_settings WHERE name='search_path') AS search_path
  `);
  console.log("🔎 PG info (real):", rows[0]);

  const { rows: t } = await pool.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema IN (current_schema(), 'public')
      AND table_name IN ('uzytkownicy','monitory','powiadomienia','wykrycia','zadania_skanu')
    ORDER BY table_schema, table_name
  `);
  console.log("📋 Widoczne tabele:", t.map(r => `${r.table_schema}.${r.table_name}`));
})();

// Parsowanie JSON
app.use(express.json());

// Wstrzyknięcie PG do requestów — JEDEN pool dla całej appki
app.use((req, _res, next) => { req.pg = pool; next(); });

// (opcjonalnie) wymuś public jako search_path dla każdej sesji
pool.on('connect', (client) => {
  client.query('SET search_path TO public');
});

// Połącz MongoDB i uruchom serwer dopiero po połączeniu
connectMongo()
  .then((mongoDb) => {
    // Wstrzykuj Mongo do requestów
    app.use((req, _res, next) => { req.mongo = mongoDb; next(); });

    // Trasy API
    app.use("/auth", authRoutes);
    app.use("/api/monitory", monitoryRoutes);

    // Statyczne katalogi
    app.use(express.static(path.join(__dirname, "..", "strona")));
    app.use("/styl", express.static(path.join(__dirname, "..", "styl")));
    app.use("/skrypt", express.static(path.join(__dirname, "..", "skrypt")));
    app.use('/widoki', express.static(path.join(__dirname, '..', 'strona', 'widoki')));
    console.log('Serving /widoki from:', path.join(__dirname, '..', 'strona', 'widoki'));

    // Domyślna strona
    app.get("/", (_req, res) => {
      res.sendFile(path.join(__dirname, "..", "strona", "logowanie.html"));
    });

    // Start serwera
    app.listen(PORT, () => {
      console.log(`✅ Serwer działa na http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Błąd połączenia z MongoDB:", err);
    process.exit(1);
  });

