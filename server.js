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
