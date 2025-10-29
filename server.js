// server.js (ESM)
// Node 22.x | Express + CORS | OpenAI
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ───────────────────────────────────────────────────────────
// Env
const {
  PORT = 10000,
  ALLOW_ORIGINS = "",
  OPENAI_API_KEY = "",
  FREE_AFTER_SIGNUP = "5000", // pour l'affichage du solde gratuit
} = process.env;

// ───────────────────────────────────────────────────────────
// CORS (whitelist depuis ALLOW_ORIGINS)
const whitelist = ALLOW_ORIGINS.split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // autoriser les requêtes sans origin (ex: curl / checks de Render)
    if (!origin) return cb(null, true);
    if (whitelist.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
};

// ───────────────────────────────────────────────────────────
// App
const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// Health
app.get("/", (_req, res) => {
  res.type("text").send("OK");
});

// ───────────────────────────────────────────────────────────
// BALANCE
// Alias compatibles: /api/balance (frontend) et /api/user/balance (tests manuels)
function balancePayload() {
  // Ici on retourne juste la valeur "gratuite" pour les tests frontend.
  // Plus tard, tu brancheras sur ta base / BT.
  const free = Number(FREE_AFTER_SIGNUP) || 0;
  return { free, paid: 0 };
}

app.get("/api/balance", (_req, res) => {
  res.json(balancePayload());
});

app.get("/api/user/balance", (_req, res) => {
  res.json(balancePayload());
});

// ───────────────────────────────────────────────────────────
// CHAT
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string." });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured." });
    }

    // Appel OpenAI - chat completions
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Tu es une assistante utile et concise." },
          { role: "user", content: message },
        ],
        temperature: 0.7,
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ error: "OpenAI error", details: txt });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "Réponse indisponible pour le moment.";
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

// ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend Philomène IA en ligne sur port ${PORT}`);
});
