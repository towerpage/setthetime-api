const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ServerClient } = require("postmark");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

// ------- Database (Neon) -------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

// ------- Email (queue now; send later) -------
const postmarkToken = process.env.POSTMARK_TOKEN || "";
const postmark = postmarkToken ? new ServerClient(postmarkToken) : null;
const mailMode = process.env.MAIL_MODE || "queue"; // 'queue' until Postmark is approved

async function queueEmail({ to, from, subject, text, html, payload }) {
  const q = `
    INSERT INTO email_outbox (to_email, from_email, subject, text_body, html_body, payload, status)
    VALUES ($1,$2,$3,$4,$5,$6,'queued')
    RETURNING id
  `;
  const { rows } = await pool.query(q, [to, from, subject, text || null, html || null, payload || null]);
  return rows[0].id;
}

async function sendViaPostmark({ to, from, subject, text, html }) {
  if (!postmark) throw new Error("Postmark not available");
  const result = await postmark.sendEmail({
    From: from,
    To: to,
    Subject: subject,
    TextBody: text || undefined,
    HtmlBody: html || undefined,
    MessageStream: "outbound"
  });
  return result.MessageID;
}

async function sendEmail({ to, from, subject, text, html, payload }) {
  const useQueue = (mailMode === "queue") || !postmark;
  if (useQueue) {
    const id = await queueEmail({ to, from, subject, text, html, payload });
    return { queued: true, id };
  }
  const messageID = await sendViaPostmark({ to, from, subject, text, html });
  await pool.query(
    `INSERT INTO email_outbox (to_email, from_email, subject, text_body, html_body, payload, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sent', now())`,
    [to, from, subject, text || null, html || null, payload || null]
  );
  return { queued: false, messageID };
}

// ------- Google OAuth (for Calendar) -------
function makeOAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// ------- Basic health -------
app.get("/health", (_req, res) => res.type("text/plain").send("OK"));
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// ------- Email test (queues while awaiting Postmark approval) -------
app.get("/send-test", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).json({ ok: false, error: "missing ?to=" });
    const result = await sendEmail({
      to,
      from: "noreply@setthetime.com",
      subject: "Setthetime test",
      text: "This is a test from the Render API (queued until Postmark is approved).",
      payload: { kind: "test" }
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------- Outbox debug -------
app.get("/debug/outbox", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, to_email, subject, status, created_at FROM email_outbox ORDER BY id DESC LIMIT 20"
  );
  res.json(rows);
});

app.post("/debug/flush/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM email_outbox WHERE id=$1 AND status='queued'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "not found or not queued" });
    if (!postmark) return res.status(400).json({ ok: false, error: "Postmark not available yet" });

    const row = rows[0];
    const messageID = await sendViaPostmark({
      to: row.to_email,
      from: row.from_email,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body
    });
    await pool.query("UPDATE email_outbox SET status='sent', sent_at=now() WHERE id=$1", [row.id]);
    res.json({ ok: true, messageID });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------- Google OAuth routes -------
app.get("/oauth/google/start", (_req, res) => {
  const oauth2 = makeOAuth();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
  res.redirect(url);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).type("text/plain").send("Missing code");

    const oauth2 = makeOAuth();
    const { tokens } = await oauth2.getToken(code);

    const userId = process.env.TEST_USER_ID;
    const expiryMs = tokens.expiry_date || (Date.now() + 3600 * 1000);
    const scopeStr = (tokens.scope && String(tokens.scope)) || SCOPES.join(" ");

    await pool.query(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry, scope, created_at, updated_at)
       VALUES ($1,'google',$2,$3,to_timestamp($4/1000),$5, now(), now())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
                     expiry = EXCLUDED.expiry,
                     scope = EXCLUDED.scope,
                     updated_at = now()`,
      [userId, tokens.access_token, tokens.refresh_token || null, expiryMs, scopeStr]
    );

    res.type("text/plain").send("Google connected");
  } catch (e) {
    res.status(500).type("text/plain").send(`OAuth error: ${e.message}`);
  }
});

app.get("/oauth/google/status", async (_req, res) => {
  const userId = process.env.TEST_USER_ID;
  const { rows } = await pool.query(
    "SELECT provider, expiry, updated_at FROM oauth_tokens WHERE user_id=$1 AND provider='google'",
    [userId]
  );
  if (!rows.length) return res.json({ connected: false });
  return res.json({ connected: true, expiry: rows[0].expiry, updated_at: rows[0].updated_at });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
