import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Clerk } from "@clerk/clerk-sdk-node"; // ⬅ important
dotenv.config();

const app = express();

// Clerk (clé secrète côté backend)
const clerk = new Clerk({ secretKey: process.env.CLERK_SECRET_KEY });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// CORS
const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS: " + origin));
    },
  })
);

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Montant tokens
const FREE_GUEST_TOKENS = 1000;   // invité
const VERIFIED_TOKENS   = 5000;   // après email confirmé

// mémoire en RAM
const sessions = new Map();  // userId -> {turns: [...]}
const balances = new Map();  // userId -> { tokens: number, verified: boolean }
const MAX_TURNS = 12;

// helper: récupère ou crée session
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

// helper: init solde utilisateur
async function initUserBalance(userId, clerkToken) {
  if (balances.has(userId)) return;

  // Cas invité (pas de token Clerk envoyé)
  if (!clerkToken) {
    balances.set(userId, {
      tokens: FREE_GUEST_TOKENS,
      verified: false,
      email: null,
    });
    return;
  }

  // Cas connecté avec Clerk: on regarde si le mail est vérifié
  try {
    // Vérifier le token Clerk envoyé par le front
    // On récupère l'utilisateur
    const { userId: uid } = await clerk.verifyToken(clerkToken);
    const user = await clerk.users.getUser(uid);

    // email primaire
    const primaryEmail = user?.emailAddresses?.find(
      e => e.id === user.primaryEmailAddressId
    );

    const isVerified = primaryEmail?.verification?.status === "verified";

    balances.set(uid, {
      tokens: isVerified ? VERIFIED_TOKENS : FREE_GUEST_TOKENS,
      verified: !!isVerified,
      email: primaryEmail?.emailAddress || null,
    });
  } catch (err) {
    console.error("Erreur Clerk:", err);
    // si le token est pas bon, on retombe en mode invité
    balances.set(userId, {
      tokens: FREE_GUEST_TOKENS,
      verified: false,
      email: null,
    });
  }
}

// helper: construit messages pour OpenAI
function buildMessages(userId, text, imageDataUrl) {
  const s = getSession(userId);

  const baseSystem = {
    role: "system",
    content:
      "Tu es Philomène IA. Tu parles clair, simple, utile. " +
      "Tu réponds d'abord en français sauf si l'utilisateur parle clairement une autre langue. " +
      "Pour l'actualité/politique, tu précises si tu n'es pas sûr que c'est à jour.",
  };

  const history = s.turns.map(t => ({ role: t.role, content: t.content }));

  let lastUserMsg;
  if (imageDataUrl) {
    lastUserMsg = {
      role: "user",
      content: [
        { type: "text", text: text || "Analyse cette image." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    };
  } else {
    lastUserMsg = { role: "user", content: text };
  }

  return [baseSystem, ...history, lastUserMsg];
}

// route santé
app.get("/", (_, res) => {
  res.send("✅ API Philomène IA en ligne.");
});

// récupérer le statut (tokens restants + email + verified)
app.get("/api/status", async (req, res) => {
  // le front nous enverra userId local + (optionnel) le token Clerk
  const userId = req.query.userId || "guest";
  const clerkToken = req.query.clerkToken || null;

  await initUserBalance(userId, clerkToken);

  const info = balances.get(userId);
  res.json({
    userId,
    email: info.email,
    verified: info.verified,
    tokens: info.tokens,
  });
});

// vider conversation (bouton "Vider chat")
app.post("/api/clear", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId requis" });

  sessions.delete(userId);
  res.json({ ok: true });
});

// envoyer un message / photo
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, imageDataUrl, clerkToken } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId requis" });
    if (!message && !imageDataUrl)
      return res.status(400).json({ error: "message ou image requis" });

    // s'assurer qu'on a bien initialisé ce user (avec clerk ou invité)
    await initUserBalance(userId, clerkToken);

    const wallet = balances.get(userId);
    if (!wallet) return res.status(500).json({ error: "wallet introuvable" });

    // pas de tokens dispo
    if (wallet.tokens <= 0) {
      return res.status(402).json({
        error: "Solde insuffisant",
        remaining: 0,
      });
    }

    // si pas de clé OpenAI => mode démo sans facturation
    if (!OPENAI_API_KEY) {
      pushTurn(userId, "user", message || "(photo)");
      const fake = "Mode test: ajoute ta clé OPENAI_API_KEY sur Render.";
      pushTurn(userId, "assistant", fake);
      return res.json({
        reply: fake,
        usage: { total_tokens: 0 },
        remaining: wallet.tokens,
        verified: wallet.verified,
        email: wallet.email,
      });
    }

    // construire le prompt avec historique
    const messages = buildMessages(userId, message || "", imageDataUrl);

    // Appel OpenAI
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
      return res
        .status(500)
        .json({ error: j.error?.message || "OpenAI error" });
    }

    const reply =
      j?.choices?.[0]?.message?.content?.trim() ||
      "Désolé, pas de réponse.";
    const usedTokens = Number(j?.usage?.total_tokens || 0);

    // mémoriser tour
    pushTurn(userId, "user", message || "(photo)");
    pushTurn(userId, "assistant", reply);

    // décrémente les tokens du wallet
    wallet.tokens = Math.max(0, wallet.tokens - usedTokens);

    res.json({
      reply,
      remaining: wallet.tokens,
      used: usedTokens,
      verified: wallet.verified,
      email: wallet.email,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log("✅ API Philomène IA sur port", PORT);
});
