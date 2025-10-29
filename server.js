/* =========================================
   Philomène IA – Backend minimal propre
   ========================================= */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

/* ---------- Config ---------- */
const PORT = process.env.PORT || 10000;

// Origines autorisées, séparées par des virgules dans ALLOW_ORIGINS
// ex: https://philomeneia.com,https://www.philomeneia.com,https://philo-ne-ia-site.onrender.com
const allowedOrigins = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const FREE_AFTER_SIGNUP = Number(process.env.FREE_AFTER_SIGNUP || 5000);
const FREE_ANON = Number(process.env.FREE_ANON || 1000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquant. Les appels IA échoueront.");
}

/* ---------- App & middlewares ---------- */
const app = express();

app.use(express.json({ limit: "5mb" }));

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // autorise cURL, Postman, etc.
      if (allowedOrigins.length === 0) return cb(null, true);
      const ok = allowedOrigins.includes(origin);
      cb(ok ? null : new Error("Origin not allowed by CORS"), ok);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* ---------- Stockage ultra-simple en mémoire ----------
   Suffisant pour le test. En prod, brancher une vraie base (Redis/SQL).
-------------------------------------------------------- */
const users = new Map(); // email -> { email, free, paid, createdAt }

/* ---------- Helpers ---------- */
function getOrCreateUser(email, initialFree = 0) {
  const key = email.toLowerCase();
  if (!users.has(key)) {
    users.set(key, {
      email: key,
      free: Math.max(0, initialFree),
      paid: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return users.get(key);
}

function getBalance(email) {
  const u = users.get(email.toLowerCase());
  return u ? { free: u.free, paid: u.paid, total: u.free + u.paid } : { free: 0, paid: 0, total: 0 };
}

function chargeOneToken(email) {
  const u = users.get(email.toLowerCase());
  if (!u) return false;
  if (u.free > 0) {
    u.free -= 1;
    return true;
  }
  if (u.paid > 0) {
    u.paid -= 1;
    return true;
  }
  return false;
}

/* ---------- Routes ---------- */

// Santé
app.get("/health", (_req, res) => res.json({ ok: true, service: "philo-backend", time: new Date().toISOString() }));

// Inscription ➜ attribue FREE_AFTER_SIGNUP tokens si nouveau
app.post("/api/signup", (req, res) => {
  const { email } = req.body || {};
  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: "Email invalide." });
  }
  const user = getOrCreateUser(email, FREE_AFTER_SIGNUP);
  return res.json({ ok: true, tokens: getBalance(user.email) });
});

// Compte anonyme (si tu veux un bouton « Essayer sans compte »)
app.post("/api/anon", (_req, res) => {
  // identifiant pseudo-email pour la session invitée
  const email = `anon-${Date.now()}@local`;
  const user = getOrCreateUser(email, FREE_ANON);
  return res.json({ ok: true, email: user.email, tokens: getBalance(user.email) });
});

// Infos utilisateur (affichage « Connecté: » + solde)
app.get("/api/me", (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Paramètre 'email' requis." });
  const tokens = getBalance(email);
  return res.json({ ok: true, email: email.toLowerCase(), tokens });
});

// Solde direct
app.get("/api/tokens", (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Paramètre 'email' requis." });
  return res.json({ ok: true, tokens: getBalance(email) });
});

// Conversation IA (décrémente 1 token par requête)
app.post("/api/message", async (req, res) => {
  const { email, message, lang } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email requis." });
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message requis." });
  }

  const exists = users.has(email.toLowerCase());
  if (!exists) getOrCreateUser(email, 0); // si pas inscrit, pas de free auto
  if (!chargeOneToken(email)) {
    return res.status(402).json({ error: "Plus de tokens." });
  }

  let reply = "(Réponse IA indisponible)";
  try {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");

    // Prompt très simple. Tu pourras le spécialiser plus tard.
    const sys = `Tu es "Philomène IA", un assistant personnel bienveillant.
Réponds en ${lang || "fr"}. Fais court, utile et clair.`;

    const body = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: message },
      ],
      temperature: 0.4,
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`OpenAI ${r.status}: ${txt}`);
    }

    const data = await r.json();
    reply = data?.choices?.[0]?.message?.content?.trim() || reply;
  } catch (e) {
    console.error("OpenAI error:", e.message);
    reply = "Désolé, le service IA a eu un souci temporaire. Réessaie dans un instant.";
  }

  return res.json({ ok: true, reply, tokens: getBalance(email) });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`✅ Backend Philomène IA démarré sur port ${PORT}`);
});
