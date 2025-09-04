const express = require("express");
const app = express();

app.get("/health", (_req, res) => res.type("text/plain").send("OK"));
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
