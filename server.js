const express = require("express");
const app = express();

app.get("/health", (_req, res) => {
  console.log("GET /health at", new Date().toISOString());
  res.set("Content-Type", "application/json");
  res.status(200).send(JSON.stringify({ ok: true }));
});

app.get("/", (_req, res) => res.type("text/plain").send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));

const { ServerClient } = require("postmark");
const mail = new ServerClient(process.env.POSTMARK_TOKEN);

app.get("/send-test", async (req, res) => {
  try {
    const to = req.query.to; // e.g., ?to=you%40gmail.com
    if (!to) return res.status(400).json({ ok: false, error: "missing ?to=" });

    const result = await mail.sendEmail({
      From: "noreply@setthetime.com",  // must be on your verified domain
      To: to,
      Subject: "Setthetime test",
      TextBody: "This is a test from the Render API."
    });

    res.json({ ok: true, messageID: result.MessageID });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
