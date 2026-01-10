import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import express from 'express';

import { pool } from './polaczeniePG.js';
import { connectMongo } from './polaczenieMDB.js';

import authRoutes from './routes/auth.js';
import monitoryRoutes from './routes/monitory.js';
import pluginTasksRouter from './routes/pluginTasks.js';
import historiaRoutes from './routes/historia.js';
import statystykiRoutes from './routes/statystyki.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 JWT_SECRET loaded:', process.env.JWT_SECRET ? '✅ OK' : '❌ MISSING');

const app = express();
const PORT = 3001;

console.log('ℹ️ polaczeniePG path:', import.meta.url.replace(/serwerStart\.js$/, 'polaczeniePG.js'));

(async () => {
  const cfg = {
    host: pool.options.host,
    port: pool.options.port,
    user: pool.options.user,
    database: pool.options.database,
  };
  console.log('ℹ️ Pool options:', cfg);

  const { rows } = await pool.query(`
    SELECT current_database() AS db,
           current_user AS usr,
           inet_server_addr()::text AS host,
           inet_server_port() AS port,
           (SELECT setting FROM pg_settings WHERE name='search_path') AS search_path
  `);
  console.log('✅ PG connected:', rows[0]);
})().catch((e) => console.error('❌ PG check failed:', e));

// UWAGA: nie ustawiamy globalnego express.json() przed /api/plugin-tasks,
// bo wtedy duże screenshoty mogą dostać 413 zanim trafią do routera.
app.use((req, _res, next) => {
  req.pg = pool;
  next();
});

connectMongo()
  .then((mongoDb) => {
    console.log('✅ Połączono z MongoDB');

    app.use((req, _res, next) => {
      req.mongo = mongoDb;
      next();
    });

    // 1) najpierw plugin-tasks (router ma swój limit 50mb)
    app.use('/api/plugin-tasks', pluginTasksRouter);

    // 2) dopiero potem globalny parser dla reszty API
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // 3) reszta tras
    app.use('/auth', authRoutes);
    app.use('/api/monitory', monitoryRoutes);
    app.use('/api/historia', historiaRoutes);
    app.use('/api/statystyki', statystykiRoutes);


    app.use(express.static(path.join(__dirname, '..', 'strona')));
    app.use('/styl', express.static(path.join(__dirname, '..', 'styl')));
    app.use('/skrypt', express.static(path.join(__dirname, '..', 'skrypt')));
    app.use('/widoki', express.static(path.join(__dirname, '..', 'strona', 'widoki')));
    console.log('Serving /widoki from:', path.join(__dirname, '..', 'strona', 'widoki'));

    app.get('/', (_req, res) => {
      res.sendFile(path.join(__dirname, '..', 'strona', 'logowanie.html'));
    });

    app.listen(PORT, () => {
      console.log(`✅ Serwer działa na http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Błąd połączenia z MongoDB:', err);
    process.exit(1);
  });

