// server.js — Philomène IA backend
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();

// autoriser gros payloads pour les photos
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// CORS (domaines autorisés)
const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // iPhone local preview
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS: " + origin));
    },
  })
);

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// configuration des cadeaux tokens
const GUEST_START_TOKENS = Number(process.env.GUEST_START_TOKENS || 1000);   // invité
const USER_START_TOKENS  = Number(process.env.USER_START_TOKENS  || 5000);   // compte Clerk

// mémoire côté serveur
// balances : Map(userId -> number de tokens restants)
// sessions : Map(userId -> { turns: [{role,content}], ... })
const balances = new Map();
const sessions = new Map();
const MAX_TURNS = 12;

// helpers mémoire
function initBalanceIfNeeded(userId, isGuest = false) {
  if (!balances.has(userId)) {
    if (isGuest) {
      balances.set(userId, GUEST_START_TOKENS);
    } else {
      balances.set(userId, USER_START_TOKENS);
    }
  }
}
function getBalance(userId) {
  return balances.get(userId) || 0;
}
function setBalance(userId, value) {
  balances.set(userId, value);
}

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { turns: [] });
  return sessions.get(userId);
}
function pushTurn(userId, role, content) {
  const s = getSession(userId);
  s.turns.push({ role, content });
  if (s.turns.length > MAX_TURNS) {
    s.turns.splice(0, s.turns.length - MAX_TURNS);
  }
}

// construit l'historique + consignes système
function buildMessages(userId, text, imageDataUrl) {
  const s = getSession(userId);

  const systemPrompt = `
Tu es Philomène IA.
Tu aides à tout : devoirs, mails, réparations, cuisine, idées business, support perso.
Tu expliques étape par étape, en français par défaut sauf si l'utilisateur parle clairement une autre langue.
Tu restes calme, simple, sans gros mots.
Actualité / politique : tu donnes la dernière info que tu connais, tu dis clairement que ça peut avoir changé après ta dernière mise à jour. Ne pas inventer du "en ce moment" si tu n'es pas sûre.
Si l'utilisateur envoie une image, tu décris ce que tu vois et tu aides à diagnostiquer ou expliquer.
  `.trim();

  const msgs = [
    { role: "system", content: systemPrompt },
    ...s.turns.map(t => ({ role: t.role, content: t.content })),
  ];

  if (imageDataUrl) {
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: text || "Analyse cette image." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    });
  } else {
    msgs.push({ role: "user", content: text });
  }

  return msgs;
}

// ————————————————————
// ROUTES
// ————————————————————

// simple ping
app.get("/", (_, res) => {
  res.send("✅ Philomène IA backend en ligne");
});

// 1) démarrer une session INVITÉ
// le front appelle ça quand l'app charge et que l'utilisateur n'a pas encore de compte
app.post("/api/guest-start", (req, res) => {
  // On génère un ID invité simple si le front n'en donne pas déjà un
  // Sur mobile sans stockage long terme, on peut juste en faire un nouveau à chaque rafraîchissement
  const guestId = "guest-" + Math.random().toString(36).slice(2, 8);

  // on initialise son solde si pas encore fait
  initBalanceIfNeeded(guestId, true);

  res.json({
    userId: guestId,
    email: null,
    tokens: getBalance(guestId),
    mode: "guest",
  });
});

// 2) démarrer une session UTILISATEUR VÉRIFIÉ (Clerk)
// plus tard on l'appellera après login Clerk depuis le front
app.post("/api/auth-start", (req, res) => {
  const { userId, email } = req.body || {};
  if (!userId || !email) {
    return res.status(400).json({ error: "userId et email requis" });
  }

  // si on ne l'a jamais vu -> cadeau 5000
  initBalanceIfNeeded(userId, false);

  res.json({
    userId,
    email,
    tokens: getBalance(userId),
    mode: "user",
  });
});

// 3) solde courant
app.get("/api/balance", (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: "userId requis" });
  }
  res.json({
    free: getBalance(userId),
    paid: 0,
  });
});

// 4) reset conversation (debug)
app.post("/api/clear", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId requis" });
  sessions.delete(userId);
  res.json({ ok: true });
});

// 5) chat principal
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, imageDataUrl } = req.body || {};
    if (!userId) {
      return res.status(400).json({ error: "userId requis" });
    }
    if (!message && !imageDataUrl) {
      return res.status(400).json({ error: "message ou image requis" });
    }

    // vérifier solde
    const remaining = getBalance(userId);
    if (remaining <= 0) {
      return res.status(402).json({
        error: "Solde insuffisant",
        remaining: 0,
      });
    }

    // si pas de clé OpenAI -> mode test
    if (!OPENAI_API_KEY) {
      pushTurn(userId, "user", message || "(photo)");
      const fake = "Mode test: ajoute ta clé OPENAI_API_KEY sur Render.";
      pushTurn(userId, "assistant", fake);
      return res.json({
        reply: fake,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        remaining: remaining,
      });
    }

    // construire la conversation
    const messages = buildMessages(userId, message || "", imageDataUrl);

    // appel OpenAI GPT-4 Turbo
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        temperature: 0.4,
        messages,
      }),
    });

    const j = await r.json();
    if (!r.ok) {
      console.error(j);
      return res.status(500).json({ error: j.error?.message || "OpenAI error" });
    }

    const reply =
      j?.choices?.[0]?.message?.content?.trim() ||
      "Désolé, pas de réponse.";

    const usage = j?.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // mettre à jour la mémoire
    pushTurn(userId, "user", message || "(photo)");
    pushTurn(userId, "assistant", reply);

    // décrémenter les tokens restants
    const used = Number(usage.total_tokens || 0); // tokens OpenAI réels
    const newBalance = Math.max(0, remaining - used);
    setBalance(userId, newBalance);

    res.json({
      reply,
      usage,
      remaining: newBalance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log("✅ Philomène IA backend démarré sur le port", PORT);
});
