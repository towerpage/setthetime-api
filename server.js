const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ServerClient } = require("postmark");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   Database (Neon / Postgres)
   ========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

/* =========================
   Email (Postmark, queued until approval)
   ========================= */
const postmarkToken = process.env.POSTMARK_TOKEN || "";
const postmark = postmarkToken ? new ServerClient(postmarkToken) : null;
const mailMode = process.env.MAIL_MODE || "queue"; // 'queue' or 'send'

async function queueEmail({ to, from, subject, text, html, payload }) {
  const q = `
    INSERT INTO email_outbox (to_email, from_email, subject, text_body, html_body, payload, status)
    VALUES ($1,$2,$3,$4,$5,$6,'queued')
    RETURNING id
  `;
  const { rows } = await pool.query(q, [
    to,
    from,
    subject,
    text || null,
    html || null,
    payload || null,
  ]);
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
    MessageStream: "outbound",
  });
  return result.MessageID;
}

async function sendEmail({ to, from, subject, text, html, payload }) {
  const useQueue = mailMode === "queue" || !postmark;
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

/* =========================
   Google OAuth (Calendar)
   ========================= */
function makeOAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

/* Build OAuth client for a user and auto-persist refreshed tokens */
async function getGoogleAuthForUser(userId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expiry FROM oauth_tokens WHERE user_id=$1 AND provider='google'",
    [userId]
  );
  if (!rows.length) throw new Error("Google not connected for user");
  const row = rows[0];

  const oauth2 = makeOAuth();
  oauth2.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token || undefined,
    expiry_date: row.expiry ? new Date(row.expiry).getTime() : undefined,
  });

  oauth2.on("tokens", async (tokens) => {
    try {
      const expiryIso = tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null;
      await pool.query(
        `UPDATE oauth_tokens
           SET access_token = COALESCE($1, access_token),
               refresh_token = COALESCE($2, refresh_token),
               expiry = COALESCE($3::timestamptz, expiry),
               updated_at = now()
         WHERE user_id=$4 AND provider='google'`,
        [
          tokens.access_token || null,
          tokens.refresh_token || null,
          expiryIso,
          userId,
        ]
      );
    } catch {
      /* ignore refresh persist errors */
    }
  });

  return oauth2;
}

/* =========================
   Basic health
   ========================= */
app.get("/health", (_req, res) => res.type("text/plain").send("OK"));
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

/* =========================
   Email test + outbox debug
   ========================= */
app.get("/send-test", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).json({ ok: false, error: "missing ?to=" });
    const result = await sendEmail({
      to,
      from: "noreply@setthetime.com",
      subject: "Setthetime test",
      text: "This is a test from the Render API (queued until Postmark is approved).",
      payload: { kind: "test" },
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/outbox", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, to_email, subject, status, created_at FROM email_outbox ORDER BY id DESC LIMIT 20"
  );
  res.json(rows);
});

app.post("/debug/flush/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM email_outbox WHERE id=$1 AND status='queued'",
      [req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "not found or not queued" });
    if (!postmark)
      return res
        .status(400)
        .json({ ok: false, error: "Postmark not available yet" });

    const row = rows[0];
    const messageID = await sendViaPostmark({
      to: row.to_email,
      from: row.from_email,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body,
    });
    await pool.query(
      "UPDATE email_outbox SET status='sent', sent_at=now() WHERE id=$1",
      [row.id]
    );
    res.json({ ok: true, messageID });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   Google OAuth routes
   ========================= */
app.get("/oauth/google/start", (_req, res) => {
  const oauth2 = makeOAuth();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
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
    const expiryIso = new Date(
      tokens.expiry_date ?? Date.now() + 3600 * 1000
    ).toISOString();
    const scopeStr =
      (tokens.scope && String(tokens.scope)) || SCOPES.join(" ");

    await pool.query(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry, scope, created_at, updated_at)
       VALUES ($1,'google',$2,$3,$4::timestamptz,$5, now(), now())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
                     expiry = EXCLUDED.expiry,
                     scope = EXCLUDED.scope,
                     updated_at = now()`,
      [
        userId,
        tokens.access_token,
        tokens.refresh_token || null,
        expiryIso,
        scopeStr,
      ]
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
  return res.json({
    connected: true,
    expiry: rows[0].expiry,
    updated_at: rows[0].updated_at,
  });
});

/* =========================
   Availability (reads Google Calendar busy times)
   ========================= */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// GET /availability?meetingTypeId=...&from=ISO&to=ISO
app.get("/availability", async (req, res) => {
  try {
    const meetingTypeId = req.query.meetingTypeId;
    const fromIso = req.query.from;
    const toIso = req.query.to;

    if (!meetingTypeId || !fromIso || !toIso) {
      return res
        .status(400)
        .json({ error: "missing meetingTypeId, from, or to" });
    }

    // Load meeting type
    const mtQ = await pool.query(
      "SELECT user_id, duration_minutes, timezone FROM meeting_types WHERE id=$1",
      [meetingTypeId]
    );
    if (!mtQ.rows.length)
      return res.status(404).json({ error: "meeting type not found" });

    const mt = mtQ.rows[0];
    const userId = mt.user_id;

    // Google Calendar free/busy
    const auth = await getGoogleAuthForUser(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const timeMin = new Date(fromIso).toISOString();
    const timeMax = new Date(toIso).toISOString();

    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: "primary" }] },
    });

    const busy = (fb.data.calendars?.primary?.busy || []).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));

    // Candidate slots on duration increments
    const durMin = Number(mt.duration_minutes);
    const stepMs = durMin * 60 * 1000;
    const startMs = new Date(timeMin).getTime();
    const endMs = new Date(timeMax).getTime();

    const slots = [];
    for (let t = startMs; t + stepMs <= endMs; t += stepMs) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + stepMs);

      let conflict = false;
      for (const b of busy) {
        if (overlaps(slotStart, slotEnd, b.start, b.end)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
        });
      }
    }

    res.json({
      meetingTypeId,
      timeMin,
      timeMax,
      durationMinutes: durMin,
      slots,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* =========================
   Booking (chosen slot creates a Calendar event, stores it in Postgres, and queues emails)
   ========================= */
// POST /book  JSON body: { meetingTypeId, recipient_name, recipient_email, start_time }
// start_time must be an ISO string from /availability (e.g., "2025-09-07T13:00:00.000Z")
app.post("/book", async (req, res) => {
  try {
    const { meetingTypeId, recipient_name, recipient_email, start_time } = req.body;

    if (!meetingTypeId || !recipient_name || !recipient_email || !start_time) {
      return res.status(400).json({ ok: false, error: "missing meetingTypeId, recipient_name, recipient_email, or start_time" });
    }
    const start = new Date(start_time);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ ok: false, error: "invalid start_time" });
    }

    // Load meeting type and host info
    const mtQ = await pool.query(
      "SELECT id, user_id, title, duration_minutes FROM meeting_types WHERE id=$1",
      [meetingTypeId]
    );
    if (!mtQ.rows.length) return res.status(404).json({ ok: false, error: "meeting type not found" });
    const mt = mtQ.rows[0];

    const hostQ = await pool.query("SELECT email FROM users WHERE id=$1", [mt.user_id]);
    if (!hostQ.rows.length) return res.status(500).json({ ok: false, error: "host user missing" });
    const hostEmail = hostQ.rows[0].email;

    const end = new Date(start.getTime() + Number(mt.duration_minutes) * 60 * 1000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // Double-check busy in Google
    const auth = await getGoogleAuthForUser(mt.user_id);
    const calendar = google.calendar({ version: "v3", auth });
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin: startIso, timeMax: endIso, items: [{ id: "primary" }] },
    });
    const busy = fb.data.calendars?.primary?.busy || [];
    if (busy.length > 0) {
      return res.status(409).json({ ok: false, error: "slot not available (calendar busy)" });
    }

    // Check local bookings overlap for this host (avoid double-book with other meeting types)
    const overlapQ = await pool.query(
      `SELECT 1
         FROM bookings b
         JOIN meeting_types m ON m.id = b.meeting_type_id
        WHERE m.user_id = $1
          AND b.status = 'confirmed'
          AND NOT (b.end_time <= $2 OR b.start_time >= $3)
        LIMIT 1`,
      [mt.user_id, startIso, endIso]
    );
    if (overlapQ.rows.length) {
      return res.status(409).json({ ok: false, error: "slot not available (existing booking)" });
    }

    // Create Google Calendar event
    const summary = `${mt.title} with ${recipient_name}`;
    const description = `Booked via setthetime.com`;
    const eventResp = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: { dateTime: startIso },
        end:   { dateTime: endIso },
        attendees: [{ email: hostEmail }, { email: recipient_email }],
        reminders: { useDefault: true }
      }
    });
    const eventId = eventResp.data.id;

    // Store booking
    const insertQ = await pool.query(
      `INSERT INTO bookings (meeting_type_id, recipient_name, recipient_email, start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5,'confirmed')
       RETURNING id`,
      [meetingTypeId, recipient_name, recipient_email, startIso, endIso]
    );
    const bookingId = insertQ.rows[0].id;

    // Queue emails (sent later when Postmark is approved)
    await sendEmail({
      to: recipient_email,
      from: "noreply@setthetime.com",
      subject: `Confirmed: ${mt.title}`,
      text: `You're booked with ${hostEmail} from ${startIso} to ${endIso} (UTC).\nEvent: ${eventId}`
    });
    await sendEmail({
      to: hostEmail,
      from: "noreply@setthetime.com",
      subject: `New booking: ${mt.title}`,
      text: `${recipient_name} <${recipient_email}> booked ${startIso}–${endIso} (UTC).\nEvent: ${eventId}`
    });

    return res.json({ ok: true, bookingId, eventId, start: startIso, end: endIso });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


/* =========================
   Start server
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));

