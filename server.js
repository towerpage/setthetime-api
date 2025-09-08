const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ServerClient } = require("postmark");
const { google } = require("googleapis");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(cors({
  origin: ['https://app.setthetime.com', 'https://link.setthetime.com'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.use(express.json());

/* =========================
   Env
   ========================= */
const APP_BASE = process.env.APP_BASE_URL || 'https://app.setthetime.com';
const FROM_EMAIL = process.env.FROM_EMAIL || "service@setthetime.com";
const SESSION_SECRET = process.env.SESSION_SECRET || "CHANGE_ME";

/* =========================
   Database (Neon / Postgres)
   ========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

/* =========================
   Email (Postmark; queue until approved)
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
  const { rows } = await pool.query(q, [to, from, subject, text || null, html || null, payload || null]);
  return rows[0].id;
}
async function sendViaPostmark({ to, from, subject, text, html }) {
  if (!postmark) throw new Error("Postmark not available");
  const result = await postmark.sendEmail({
    From: from, To: to, Subject: subject,
    TextBody: text || undefined, HtmlBody: html || undefined,
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
   Stateless sessions (signed token)
   ========================= */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function signToken(payloadObj, maxAgeSec = 30 * 24 * 3600) { // 30d
  const payload = { ...payloadObj, exp: Math.floor(Date.now()/1000) + maxAgeSec };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig !== expected) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8')); } catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now()/1000)) return null;
  return payload;
}
function getAuthUserId(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(Array.isArray(h) ? h[0] : h);
  if (!m) return null;
  const p = verifyToken(m[1]);
  return p?.uid || null;
}
function requireAuth(req, res, next) {
  const uid = getAuthUserId(req);
  if (!uid) return res.status(401).json({ ok:false, error: 'unauthorized' });
  req.userId = uid;
  next();
}

/* =========================
   Google OAuth (Login + Calendar)
   ========================= */
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events"
];

function makeOAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
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
      const expiryIso = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
      await pool.query(
        `UPDATE oauth_tokens
           SET access_token = COALESCE($1, access_token),
               refresh_token = COALESCE($2, refresh_token),
               expiry = COALESCE($3::timestamptz, expiry),
               updated_at = now()
         WHERE user_id=$4 AND provider='google'`,
        [tokens.access_token || null, tokens.refresh_token || null, expiryIso, userId]
      );
    } catch {}
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
      to, from: FROM_EMAIL, subject: "Setthetime test",
      text: "This is a test from the Render API (queued until Postmark is approved).",
      payload: { kind: "test" },
    });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/debug/outbox", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, to_email, from_email, subject, status, created_at
       FROM email_outbox
      ORDER BY id DESC
      LIMIT 20`
  );
  res.json(rows);
});

app.post("/debug/flush/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM email_outbox WHERE id=$1 AND status='queued'",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not found or not queued" });
    if (!postmark)   return res.status(400).json({ ok: false, error: "Postmark not available yet" });

    const row = rows[0];
    const messageID = await sendViaPostmark({
      to: row.to_email, from: row.from_email, subject: row.subject,
      text: row.text_body, html: row.html_body,
    });
    await pool.query("UPDATE email_outbox SET status='sent', sent_at=now() WHERE id=$1", [row.id]);
    res.json({ ok: true, messageID });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* =========================
   Auth: signup + session
   ========================= */
// POST /signup  { email, name?, timezone? }  -> { ok, userId, token, loginUrl }
app.post("/signup", async (req, res) => {
  try {
    const { email, name, timezone } = req.body || {};
    if (!email) return res.status(400).json({ ok:false, error: "missing email" });

    // ensure user exists
    let userId;
    const u1 = await pool.query("SELECT id FROM users WHERE email=$1 LIMIT 1", [email]);
    if (u1.rows.length) {
      userId = u1.rows[0].id;
      if (name) await pool.query("UPDATE users SET name=$1 WHERE id=$2", [name, userId]);
      if (timezone) await pool.query("UPDATE users SET timezone=$1 WHERE id=$2", [timezone, userId]);
    } else {
      const u2 = await pool.query(
        "INSERT INTO users (email, name, timezone) VALUES ($1,$2,$3) RETURNING id",
        [email, name || null, timezone || null]
      );
      userId = u2.rows[0].id;
    }

    // issue short-lived login token (15 min)
    const linkToken = signToken({ uid: userId, kind: "link" }, 15 * 60);
    const loginUrl = `${APP_BASE}?token=${encodeURIComponent(linkToken)}`;

    // queue magic-link email
    await sendEmail({
      to: email, from: FROM_EMAIL,
      subject: "Your setthetime sign-in link",
      text: `Click to sign in: ${loginUrl}`
    });

    return res.json({ ok:true, userId, token: linkToken, loginUrl });
  } catch (e) { return res.status(500).json({ ok:false, error: e.message }); }
});

// POST /session/consume { token } -> { ok, userId, token }
app.post("/session/consume", async (req, res) => {
  try {
    const { token } = req.body || {};
    const p = verifyToken(token);
    if (!p?.uid) return res.status(400).json({ ok:false, error: "invalid token" });
    // issue 30-day session
    const session = signToken({ uid: p.uid, kind: "session" }, 30 * 24 * 3600);
    return res.json({ ok:true, userId: p.uid, token: session });
  } catch (e) { return res.status(500).json({ ok:false, error: e.message }); }
});

// Who am I?  -> { signedIn, userId? }
app.get("/auth/me", (req, res) => {
  const uid = getAuthUserId(req);
  if (!uid) return res.json({ signedIn: false });
  res.json({ signedIn: true, userId: uid });
});

/* =========================
   Google OAuth routes (login + calendar connect)
   ========================= */
app.get("/oauth/google/start", (_req, res) => {
  const oauth2 = makeOAuth();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: false,
    scope: SCOPES
  });
  res.redirect(url);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.redirect(`${APP_BASE}?error=Missing%20code`);

    const oauth2 = makeOAuth();
    const { tokens } = await oauth2.getToken(code);

    // identify the Google user (login)
    if (!tokens.id_token) return res.redirect(`${APP_BASE}?error=Missing%20id_token`);
    const ticket = await oauth2.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload() || {};
    const email = payload.email;
    const name = payload.name || email || 'User';
    if (!email) return res.redirect(`${APP_BASE}?error=No%20email`);

    // upsert user
    let userId;
    const u1 = await pool.query("SELECT id FROM users WHERE email=$1 LIMIT 1", [email]);
    if (u1.rows.length) {
      userId = u1.rows[0].id;
      await pool.query("UPDATE users SET name=COALESCE($1,name) WHERE id=$2", [name, userId]);
    } else {
      const u2 = await pool.query("INSERT INTO users (email, name) VALUES ($1,$2) RETURNING id", [email, name]);
      userId = u2.rows[0].id;
    }

    // store Calendar tokens
    const expiryIso = new Date(tokens.expiry_date ?? (Date.now() + 3600 * 1000)).toISOString();
    const scopeStr = (tokens.scope && String(tokens.scope)) || SCOPES.join(" ");
    await pool.query(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry, scope, created_at, updated_at)
       VALUES ($1,'google',$2,$3,$4::timestamptz,$5, now(), now())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
                     expiry = EXCLUDED.expiry,
                     scope = EXCLUDED.scope,
                     updated_at = now()`,
      [userId, tokens.access_token, tokens.refresh_token || null, expiryIso, scopeStr]
    );

    // issue session and return to app
    const session = signToken({ uid: userId, kind: "session" }, 30 * 24 * 3600);
    return res.redirect(`${APP_BASE}?token=${encodeURIComponent(session)}&connected=1`);
  } catch (e) {
    return res.redirect(`${APP_BASE}?error=${encodeURIComponent(e.message)}`);
  }
});

// Calendar token status for the signed-in user
app.get("/oauth/google/status", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT provider, expiry, updated_at FROM oauth_tokens WHERE user_id=$1 AND provider='google'",
    [req.userId]
  );
  if (!rows.length) return res.json({ connected: false });
  return res.json({ connected: true, expiry: rows[0].expiry, updated_at: rows[0].updated_at });
});

/* =========================
   Meeting Types (create/list) — per signed-in user
   ========================= */
app.post("/meeting-types", requireAuth, async (req, res) => {
  try {
    const { title, duration_minutes, timezone } = req.body || {};
    if (!title || !duration_minutes) {
      return res.status(400).json({ ok: false, error: "missing title or duration_minutes" });
    }
    const tz = timezone || "America/New_York";
    const dur = Number(duration_minutes);
    if (!Number.isFinite(dur) || dur <= 0) {
      return res.status(400).json({ ok: false, error: "invalid duration_minutes" });
    }
    const { rows } = await pool.query(
      `INSERT INTO meeting_types (user_id, title, duration_minutes, timezone)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.userId, title, dur, tz]
    );
    return res.json({ ok: true, id: rows[0].id });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/meeting-types", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, duration_minutes, timezone, created_at
         FROM meeting_types
        WHERE user_id=$1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.userId]
    );
    return res.json({ ok: true, items: rows });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

/* =========================
   Availability (public, by meetingTypeId -> host)
   ========================= */
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

app.get("/availability", async (req, res) => {
  try {
    const meetingTypeId = req.query.meetingTypeId;
    const fromIso = req.query.from;
    const toIso = req.query.to;
    if (!meetingTypeId || !fromIso || !toIso) {
      return res.status(400).json({ error: "missing meetingTypeId, from, or to" });
    }

    const mtQ = await pool.query(
      "SELECT user_id, duration_minutes, timezone FROM meeting_types WHERE id=$1",
      [meetingTypeId]
    );
    if (!mtQ.rows.length) return res.status(404).json({ error: "meeting type not found" });

    const mt = mtQ.rows[0];
    const userId = mt.user_id;

    const auth = await getGoogleAuthForUser(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const timeMin = new Date(fromIso).toISOString();
    const timeMax = new Date(toIso).toISOString();

    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: "primary" }] },
    });

    const busy = (fb.data.calendars?.primary?.busy || []).map((b) => ({
      start: new Date(b.start), end: new Date(b.end),
    }));

    const durMin = Number(mt.duration_minutes);
    const stepMs = durMin * 60 * 1000;
    const startMs = new Date(timeMin).getTime();
    const endMs = new Date(timeMax).getTime();

    const slots = [];
    for (let t = startMs; t + stepMs <= endMs; t += stepMs) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + stepMs);
      let conflict = false;
      for (const b of busy) if (overlaps(slotStart, slotEnd, b.start, b.end)) { conflict = true; break; }
      if (!conflict) slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
    }

    res.json({ meetingTypeId, timeMin, timeMax, durationMinutes: durMin, slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
   Booking (public)
   ========================= */
/* =========================
   Booking
   ========================= */
app.post("/book", async (req, res) => {
  try {
    const { meetingTypeId, recipient_name, recipient_email, start_time } = req.body;
    if (!meetingTypeId || !recipient_name || !recipient_email || !start_time) {
      return res.status(400).json({ ok: false, error: "missing meetingTypeId, recipient_name, recipient_email, or start_time" });
    }
    const start = new Date(start_time);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ ok: false, error: "invalid start_time" });

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
    if (busy.length > 0) return res.status(409).json({ ok: false, error: "slot not available (calendar busy)" });

    // Check local bookings overlap
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
    if (overlapQ.rows.length) return res.status(409).json({ ok: false, error: "slot not available (existing booking)" });

    // Calendar event — **send Google invites automatically**
    const eventResp = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "all", // <-- ADD THIS LINE
      requestBody: {
        summary: `${mt.title} with ${recipient_name}`,
        description: `Booked via setthetime.com`,
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
       VALUES ($1,$2,$3,$4,$5,'confirmed') RETURNING id`,
      [meetingTypeId, recipient_name, recipient_email, startIso, endIso]
    );
    const bookingId = insertQ.rows[0].id;

    // Queue our own confirmations (Google already sent the invite)
    await sendEmail({
      to: recipient_email, from: "service@setthetime.com",
      subject: `Confirmed: ${mt.title}`,
      text: `You're booked with ${hostEmail} from ${startIso} to ${endIso} (UTC).\nEvent: ${eventId}`
    });
    await sendEmail({
      to: hostEmail, from: "service@setthetime.com",
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
