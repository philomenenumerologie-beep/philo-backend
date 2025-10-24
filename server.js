// --- Philomenia Backend (quotas sans coupon) ---
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

// ---- OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- CORS
const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://philomenia.com",
  "https://www.philomenia.com",
  "https://philomeneia.com",
  "https://www.philomeneia.com"
];
const ALLOWED = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // mobile apps / curl
      return cb(null, ALLOWED.includes(origin));
    }
  })
);

// ---- Tiers & quotas
// maxTokens: limite par requête vers OpenAI (sécurité)
const TIER = {
  free: { monthly: 500, maxTokens: 2000 },
  mini: { monthly: 10_000, maxTokens: 4000 },
  pro:  { monthly: 60_000, maxTokens: 8000 }
};

// ---- Stockage usage (mémoire). Pour la prod durable : Redis/DB.
const usage = {}; // { [clientId]: { [yyyymm]: { used: number } } }

const ymNow = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// ---- Helpers
const approxTokens = (str = "") => Math.ceil((str || "").length / 4);

// Détermine le palier à partir des headers
function resolveTier(req) {
  // Front enverra `x-tier: free|mini|pro` (par défaut free)
  let tier = (req.headers["x-tier"] || "free").toString().toLowerCase();
  if (!["free", "mini", "pro"].includes(tier)) tier = "free";
  return tier;
}

// Récupère l'identifiant client (à garder simple : header requis côté front)
function resolveClientId(req) {
  // front envoie un x-client-id (localStorage UID). Si absent, fallback à IP.
  return (
    (req.headers["x-client-id"] || "").toString() ||
    req.ip ||
    "anonymous"
  );
}

// Ajoute la conso et renvoie {used, remaining}
function checkAndAddUsage(clientId, tier, tokensToAdd) {
  const month = ymNow();
  usage[clientId] ||= {};
  usage[clientId][month] ||= { used: 0 };

  const limit = TIER[tier].monthly;
  const u = usage[clientId][month];
  const remaining = Math.max(0, limit - u.used);

  if (tokensToAdd > remaining) {
    return { ok: false, limit, used: u.used, remaining };
  }
  u.used += tokensToAdd;
  return { ok: true, limit, used: u.used, remaining: limit - u.used };
}

// ---- Routes

// Santé
app.get("/health", (_, res) => res.json({ ok: true }));

// Quota
app.get("/api/quota", (req, res) => {
  const clientId = resolveClientId(req);
  const tier = resolveTier(req);
  const month = ymNow();
  const u = usage[clientId]?.[month]?.used || 0;
  const limit = TIER[tier].monthly;
  res.json({
    tier,
    monthlyLimit: limit,
    used: u,
    remaining: Math.max(0, limit - u)
  });
});

// Actualités via Serper
app.get("/api/news", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Paramètre 'q' requis" });

    const r = await fetch("https://google.serper.dev/news", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY || "",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q })
    });
    const data = await r.json();

    const items = (data.news || []).slice(0, 5).map(item => ({
      title: item.title,
      link: item.link,
      source: item.source,
      date: item.date
    }));

    res.json({ results: items });
  } catch (e) {
    console.error("News error:", e);
    res.status(500).json({ error: "Erreur actus." });
  }
});

// Chat
app.post("/api/chat", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const tier = resolveTier(req);

    const messageRaw = (req.body?.message || "").toString();
    const imageBase64 = (req.body?.imageBase64 || "").toString(); // optionnel
    if (!messageRaw && !imageBase64) {
      return res.status(400).json({ error: "Message ou image requis." });
    }

    const promptTokens = approxTokens(messageRaw);
    const maxGen = TIER[tier].maxTokens;

    // On calcule la conso *avant* (prompt + sortie max théorique prudente ~50% de maxGen)
    const expected = promptTokens + Math.ceil(maxGen * 0.5);
    const quota = checkAndAddUsage(clientId, tier, expected);
    if (!quota.ok) {
      return res.status(402).json({
        error: "Quota mensuel atteint. Passe à l’abonnement supérieur.",
        quota: { used: quota.used, remaining: quota.remaining }
      });
    }

    // Messages pour OpenAI
    const messages = [
      {
        role: "system",
        content:
          "Tu es Philomène, utile, concise, avec un ton chaleureux style assistant MSN. Réponds en français si l’utilisateur parle français."
      },
    ];

    if (imageBase64) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: messageRaw || "Analyse cette image, stp." },
          {
            type: "input_image",
            image_url: { url: `data:image/png;base64,${imageBase64}` }
          }
        ]
      });
    } else {
      messages.push({ role: "user", content: messageRaw });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: maxGen,
      temperature: 0.4,
      messages
    });

    const replyText =
      completion.choices?.[0]?.message?.content?.trim() || "(pas de réponse)";
    // Ajuste la conso réelle (diff entre prévu et réel)
    const realOut = approxTokens(replyText);
    const realTotal = promptTokens + realOut;
    const month = ymNow();
    usage[clientId][month].used -= expected; // retire l'estimation
    const again = checkAndAddUsage(clientId, tier, realTotal); // pose la conso réelle
    if (!again.ok) {
      // si ça passe pas en réel (rare), on remet l'estimation initiale au lieu du réel pour ne pas bloquer
      usage[clientId][month].used += expected;
    }

    const u = usage[clientId][month].used;
    res.json({
      reply: replyText,
      quota: {
        tier,
        used: u,
        remaining: Math.max(0, TIER[tier].monthly - u)
      }
    });
  } catch (error) {
    console.error("Erreur backend:", error);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---- Lancement
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Serveur en ligne sur le port ${PORT}`);
});
