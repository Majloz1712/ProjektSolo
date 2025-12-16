// skrypt/workerPowiadomien.js
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { pool } from './polaczeniePG.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// wczytanie .env z katalogu głównego projektu (dostosuj ścieżkę jeśli trzeba)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

console.log('[worker-powiadomien] startuje...');

// 1. Konfiguracja transportu SMTP (nodemailer)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // jeśli masz port 465 i SSL "od razu", ustaw true
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// prosta weryfikacja konfiguracji
async function verifyTransport() {
  try {
    await transporter.verify();
    console.log('[worker-powiadomien] SMTP OK, gotowy do wysyłania');
  } catch (err) {
    console.error('[worker-powiadomien] BŁĄD SMTP:', err.message);
  }
}

// 2. Pobranie powiadomień ze statusem "oczekuje" + info z wykrycia
async function fetchPendingNotifications(client, limit = 20) {
  const sql = `
    SELECT
      p.id,
      p.uzytkownik_id,
      p.monitor_id,
      p.wykrycie_id,
      p.tytul AS powiadomienie_tytul,
      p.tresc AS powiadomienie_tresc,
      p.status,
      p.utworzono_at,
      u.email,
      w.url AS wykrycie_url,
      w.tytul AS wykrycie_tytul,
      w.reason AS wykrycie_reason
    FROM powiadomienia p
    JOIN uzytkownicy u ON u.id = p.uzytkownik_id
    LEFT JOIN wykrycia w ON w.id = p.wykrycie_id
    WHERE p.status = 'oczekuje'
    ORDER BY p.utworzono_at ASC
    LIMIT $1
  `;
  const { rows } = await client.query(sql, [limit]);
  return rows;
}


// 3. Wysłanie pojedynczego maila
async function sendNotificationEmail(notification) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) {
    throw new Error('Brak SMTP_FROM/SMTP_USER w .env');
  }

  const subject =
    notification.powiadomienie_tytul ||
    notification.wykrycie_tytul ||
    'Nowa istotna zmiana na monitorowanej stronie';

  const textBody = `
Cześć!

${notification.powiadomienie_tresc ||
  notification.wykrycie_reason ||
  'Wykryto istotną zmianę na monitorowanej stronie.'}

Adres strony:
${notification.wykrycie_url || 'brak url w bazie'}

ID powiadomienia: ${notification.id}
Monitor: ${notification.monitor_id}
Wykrycie: ${notification.wykrycie_id ?? 'brak'}

Pozdrawiam,
Twoja sonda zmian
`.trim();

  const mailOptions = {
    from,
    to: notification.email,
    subject,
    text: textBody,
  };

  await transporter.sendMail(mailOptions);
}


// 4. Oznaczenie powiadomienia jako wysłane
async function markAsSent(client, notificationId) {
  const sql = `
    UPDATE powiadomienia
    SET status = 'wyslane',
        wyslano_at = NOW()
    WHERE id = $1
  `;
  await client.query(sql, [notificationId]);
}

// 5. Główna funkcja obsługująca jedną "turę" worker’a
async function processBatch() {
  const client = await pool.connect();
  try {
    console.log('[worker-powiadomien] sprawdzam oczekujące powiadomienia...');
    const pending = await fetchPendingNotifications(client, 20);

    if (pending.length === 0) {
      console.log('[worker-powiadomien] brak powiadomień do wysłania.');
      return;
    }

    console.log(
      `[worker-powiadomien] znaleziono ${pending.length} powiadomien do wysłania`
    );

    for (const notif of pending) {
      try {
        console.log(
          `[worker-powiadomien] wysyłam powiadomienie ${notif.id} do ${notif.email}`
        );
        await sendNotificationEmail(notif);
        await markAsSent(client, notif.id);
        console.log(
          `[worker-powiadomien] powiadomienie ${notif.id} oznaczone jako 'wyslane'`
        );
      } catch (err) {
        // Tutaj celowo nie robimy throw, żeby inne powiadomienia się wysłały
        console.error(
          `[worker-powiadomien] błąd podczas wysyłki ${notif.id}:`,
          err.message
        );
        // opcjonalnie: możesz tu dodać logikę retries, np. status = 'blad'
      }
    }
  } catch (err) {
    console.error('[worker-powiadomien] błąd batcha:', err.message);
  } finally {
    client.release();
  }
}

// 6. Uruchomienie "pętli" worker’a
const INTERVAL_MS = Number(process.env.POWIADOMIENIA_INTERVAL_MS || 30000); // 30s domyślnie

(async () => {
  await verifyTransport();

  // pierwsze odpalenie od razu
  await processBatch();

  // kolejne co X sekund
  setInterval(processBatch, INTERVAL_MS);
})();
