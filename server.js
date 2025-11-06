// server.js
// Backend Philomène I.A.
// - /ask : conversation texte
// - /analyze-image : analyse d'image
// - /config : infos publiques paiement (PayPal)
// - mémoire de conversation en RAM (simple)
// ------------------------------------------------------------

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";

// (optionnel, utile en local)
try { await import("dotenv").then(m => m.default.config()); } catch {}

// ------------------------------------------------------------
// App & middlewares
// ------------------------------------------------------------
const app = express();
app.set("trust proxy", true);

// Limites d’upload / JSON
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS : autorise ton site (et préflight)
const corsOpts = {
  origin: ["https://philomeneia.com", "https://www.philomeneia.com"],
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOpts));
app.options("*", cors(corsOpts));

// Multer pour les images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ------------------------------------------------------------
// CONFIG ENV
// ------------------------------------------------------------
const {
  OPENAI_API_KEY = "",
  OPENAI_MODEL_TEXT = "gpt-4o-mini",
  OPENAI_MODEL_VISION = "gpt-4o-mini",
  // Compat : on accepte PAYMENT_ENABLED OU PAYMENTS_ENABLED
  PAYMENT_ENABLED,
  PAYMENTS_ENABLED,
  PAYPAL_CLIENT_ID = "",
  PAYPAL_MODE = "sandbox",
} = process.env;

// utilitaire booléen
const envTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquant. Mets-le dans Render → Environment.");
}

// ------------------------------------------------------------
// MÉMOIRE DE CONVERSATION (RAM)
// ------------------------------------------------------------
const conversations = {};

function getConversationHistory(userId) {
  if (!conversations[userId]) {
    conversations[userId] = [
      {
        role: "system",
        content:
          "Tu es Philomène I.A., une assistante personnelle française. " +
          "Réponds clairement, simplement, sans blabla inutile. " +
          "Sois sympa et directe, avec des infos concrètes.",
      },
    ];
  }
  return conversations[userId];
}

function pushToConversation(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  const MAX_MESSAGES = 60; // system + derniers tours
  if (history.length > MAX_MESSAGES) {
    const systemMsg = history[0];
    const lastMsgs = history.slice(-MAX_MESSAGES + 1);
    conversations[userId] = [systemMsg, ...lastMsgs];
  }
}

// ------------------------------------------------------------
// APPELS OPENAI
// ------------------------------------------------------------
async function askOpenAIText(messages) {
  const body = { model: OPENAI_MODEL_TEXT, messages };
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const textErr = await resp.text();
    console.error("❌ OpenAI /text status:", resp.status);
    console.error("❌ OpenAI /text body:", textErr);
    throw new Error(`Erreur API OpenAI (texte) ${resp.status}`);
  }

  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer || "Je n'ai pas pu générer de réponse.";
}

async function askOpenAIVision({ question, dataUrl }) {
  const messages = [
    {
      role: "system",
      content:
        "Tu es Philomène I.A., assistante française. Analyse l'image et explique clairement ce qu'il y a dessus. Si tu n'es pas sûre, dis-le.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: question || "Analyse l'image." },
        { type: "image_url", image_url: dataUrl },
      ],
    },
  ];
  const body = { model: OPENAI_MODEL_VISION, messages };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const textErr = await resp.text();
    console.error("❌ OpenAI /vision status:", resp.status);
    console.error("❌ OpenAI /vision body:", textErr);
    throw new Error(`Erreur API OpenAI (vision) ${resp.status}`);
  }

  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer || "Image reçue, mais impossible de l'analyser.";
}

// ------------------------------------------------------------
// ROUTES IA
// ------------------------------------------------------------
app.post("/ask", async (req, res) => {
  try {
    const { conversation, userId, tokens } = req.body || {};
    const uid = userId || "guest";

    // Dernier message user depuis le front
    let lastUserMessage = null;
    if (Array.isArray(conversation)) {
      for (let i = conversation.length - 1; i >= 0; i--) {
        const msg = conversation[i];
        if (msg.role === "user" && msg.content && msg.content.trim()) {
          lastUserMessage = msg.content.trim();
          break;
        }
      }
    }

    if (!lastUserMessage) {
      return res.status(400).json({ error: "Pas de message utilisateur reçu." });
    }

    // Mémoire
    pushToConversation(uid, "user", lastUserMessage);
    const fullHistory = getConversationHistory(uid);

    // Réponse OpenAI
    const answer = await askOpenAIText(fullHistory);

    // Sauvegarde réponse
    pushToConversation(uid, "assistant", answer);

    res.json({ answer, tokensLeft: tokens });
  } catch (err) {
    console.error("🔥 Erreur /ask:", err);
    res.status(500).json({ error: "Erreur interne /ask." });
  }
});

app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    const uid = req.body?.userId || "guest";
    const userPrompt =
      req.body?.prompt || "Décris précisément l'image et à quoi elle sert.";

    if (!req.file) return res.status(400).json({ error: "Aucune image reçue." });

    const mimeType = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    pushToConversation(uid, "user", `${userPrompt} [image envoyée]`);

    const visionAnswer = await askOpenAIVision({ question: userPrompt, dataUrl });

    pushToConversation(uid, "assistant", visionAnswer);

    res.json({ answer: visionAnswer });
  } catch (err) {
    console.error("🔥 Erreur /analyze-image:", err);
    res.status(500).json({ error: "Erreur interne /analyze-image." });
  }
});

// ------------------------------------------------------------
// CONFIG PUBLIQUE POUR LE FRONT (PayPal)
// ------------------------------------------------------------
app.get("/config", (_req, res) => {
  // priorité à PAYMENT_ENABLED, fallback PAYMENTS_ENABLED
  const paymentsEnabled = envTrue(PAYMENT_ENABLED) || envTrue(PAYMENTS_ENABLED);

  // nettoie espaces / retours ligne accidentels
  const paypalClientId = (PAYPAL_CLIENT_ID || "").trim().replace(/\s+/g, "");

  const mode = (PAYPAL_MODE || "sandbox").trim();

  // évite le cache agressif (surtout mobile)
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });

  res.json({ paymentsEnabled, paypalClientId, mode });
});

// ------------------------------------------------------------
// HEALTHCHECK
// ------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (GPT-5, mémoire, tokens).");
});

// ------------------------------------------------------------
// LANCEMENT SERVEUR
// ------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Philomène backend démarré sur le port " + PORT);
});
