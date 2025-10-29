// Philomène IA — Backend minimal propre
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ---------- Config ----------
const app = express();
app.use(express.json());

// CORS: liste d’origines autorisées via ALLOW_ORIGINS ("https://philomeneia.com,https://www.philomeneia.com")
const allowList = (process.env.ALLOW_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowList.includes("*") || allowList.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true
};
app.use(cors(corsOptions));

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "Philomène IA — API",
    time: new Date().toISOString()
  });
});

// Solde de tokens après inscription
// Usage: GET /balance?email=user@example.com
app.get("/balance", (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim();
    if (!email) return res.status(400).json({ error: "Email requis" });

    const freeTokens = parseInt(process.env.FREE_AFTER_SIGNUP || "5000", 10);
    // Tu peux plus tard brancher une vraie DB ici.
    return res.json({
      total: freeTokens,
      remaining: freeTokens
    });
  } catch (err) {
    console.error("Erreur /balance:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Catch-all (évite les 404 bruyants côté front)
app.all("*", (_req, res) => {
  res.status(404).json({ error: "Route inconnue" });
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA en ligne sur port", PORT);
});
