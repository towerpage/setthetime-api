const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ServerClient } = require("postmark");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

const postmarkToken = process.env.POSTMARK_TOKEN || "";
const mailMode = process.env.MAIL_MODE || "queue"; // 'queue' until approval

const postmark = postmarkToken ? new ServerClient(postmarkToken) : null;

async function queueEmail({ to, from, subject, text, html, payload }) {
  const q = `
    INSERT INTO email_outbox (to_email, from_email, subject, text_body, html_body, payload, status)
    VALUES ($1,$2,$3,$4,$5,$6,'queued')
    RETURNING id
  `;
  const { rows } = await pool.query(q, [to, from, subject, text || null, html || null, payload || null]);
  return rows[0].id;
}

async function sendViaPostmark({ to, from, subject, text, html, payload }) {
  const result = await postmark.sendEmail({
    From: from,
    To: to,
    Subject: subject,
    TextBody: text || undefined,
    HtmlBody: html || undefined,
    MessageStream: "outbound" // default transactional stream
  });
  // Log as sent for traceability
  await pool.query(
    `INSERT INTO email_outbox (to_email, from_email, subject, text_body, html_body, payload, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sent', now())`,
    [to, from, subject, text || null, html || null, payload || null]
  );
  return result.MessageID;
}

async function sendEmail({ to, from, subject, text, html, payload }) {
  const useQueue = (mailMode === "queue") || !postmark;
  if (useQueue) {
    const id = await queueEmail({ to, from, subject, text, html, payload });
    return { queued: true, id };
  }
  const messageID = await sendViaPostmark({ to, from, subject, text, html, payload });
  return { queued: false, messageID };
}

// Health
app.get("/health", (_req, res) => res.type("text/plain").send("OK"));
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// Test send (queues for now)
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

// Debug: view last 20 queued emails
app.get("/debug/outbox", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, to_email, subject, status, created_at FROM email_outbox ORDER BY id DESC LIMIT 20"
  );
  res.json(rows);
});

// Debug: flush one queued email (sends via Postmark when approved)
app.post("/debug/flush/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM email_outbox WHERE id=$1 AND status='queued'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "not found or not queued" });
    const row = rows[0];
    if (!postmark) return res.status(400).json({ ok: false, error: "Postmark not available yet" });

    const messageID = await sendViaPostmark({
      to: row.to_email,
      from: row.from_email,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body,
      payload: row.payload
    });
    await pool.query("UPDATE email_outbox SET status='sent', sent_at=now() WHERE id=$1", [row.id]);
    res.json({ ok: true, messageID });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
