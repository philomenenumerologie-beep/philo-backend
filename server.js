// server.js
// Backend Philomène I.A.
// - /ask           : conversation texte (gpt-4o-mini, fallback gpt-4o)
// - /analyze-image : analyse d'image (gpt-4o)
// - /barcode       : infos produit + NutriScore via OpenFoodFacts
// - /config        : infos publiques paiement + crédits gratuits
// - mémoire de conversation en RAM
// ------------------------------------------------------------

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";

// (optionnel, utile en local)
try {
  const dotenv = await import("dotenv");
  dotenv.default.config();
} catch {}

// ------------------------------------------------------------
// App & middlewares
// ------------------------------------------------------------
const app = express();
app.set("trust proxy", true);

// Limites d’upload / JSON
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS : autorise ton site
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
  OPENAI_MODEL_VISION = "gpt-4o",

  // ➜ crédits gratuits (expo dans /config)
  FREE_ANON = "2000",
  FREE_AFTER_SIGNUP = "3000",

  // Paiement
  PAYMENT_ENABLED,
  PAYMENTS_ENABLED,
  PAYPAL_CLIENT_ID = "",
  PAYPAL_MODE = "sandbox",
} = process.env;

// Clé Serper (actu en direct)
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

const envTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquant. Mets-le dans Render → Environment.");
}

if (!SERPER_API_KEY) {
  console.warn("ℹ️ SERPER_API_KEY absent : la recherche d’actualité est désactivée.");
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

  const MAX_MESSAGES = 60;
  if (history.length > MAX_MESSAGES) {
    const systemMsg = history[0];
    const lastMsgs = history.slice(-MAX_MESSAGES + 1);
    conversations[userId] = [systemMsg, ...lastMsgs];
  }
}

// ------------------------------------------------------------
// APPELS OPENAI - TEXTE
// ------------------------------------------------------------
async function askOpenAIText(messages) {
  const body = { model: OPENAI_MODEL_TEXT, messages };

  try {
    // premier essai : modèle rapide (gpt-4o-mini)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) throw new Error("Mini model failed");

    const data = await resp.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();
    return answer || "Je n'ai pas pu générer de réponse.";
  } catch (err) {
    console.warn("⚠️ gpt-4o-mini indisponible, fallback vers gpt-4o :", err.message);

    // fallback vers GPT-4o complet
    const fallbackBody = { ...body, model: "gpt-4o" };

    try {
      const retry = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fallbackBody),
      });

      const data = await retry.json();
      return (
        data?.choices?.[0]?.message?.content?.trim() ||
        "Réponse générée avec le modèle complet."
      );
    } catch (err2) {
      console.error("❌ Erreur fallback gpt-4o :", err2);
      return "Je rencontre un problème technique pour répondre pour le moment.";
    }
  }
}

// ------------------------------------------------------------
// APPELS OPENAI - VISION
// ------------------------------------------------------------
async function askOpenAIVision({ question, dataUrl }) {
  const messages = [
    {
      role: "system",
      content:
        "Tu es Philomène I.A., assistante française. Analyse l'image et explique clairement ce qu'il y a dessus. " +
        "Si tu n'es pas sûre, dis-le honnêtement.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: question || "Analyse l'image." },
        { type: "image_url", image_url: { url: dataUrl } },
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
// SERPER (ACTU EN DIRECT) – HELPERS
// ------------------------------------------------------------

// 1) Détecter si la question a besoin d’infos fraîches
function needsFreshNews(question) {
  const q = (question || "").toLowerCase();

  const keywords = [
    "aujourd'hui",
    "en ce moment",
    "en ce momment",
    "actu",
    "actualité",
    "news",
    "dernier",
    "dernière",
    "actuel",
    "actuelle",
    "qui est le président",
    "qui est la présidente",
    "qui est le premier ministre",
    "qui est la première ministre",
    "gouvernement",
    "élection",
    "election",
    "guerre",
    "conflit",
    "score",
    "résultat",
    "résultats",
    "2024",
    "2025",
    "2026",
  ];

  return keywords.some((k) => q.includes(k));
}

// 2) Appel Serper brut
async function callSerperSearch(query) {
  if (!SERPER_API_KEY) return null;

  const body = {
    q: query,
    gl: "fr", // géo France
    hl: "fr", // langue résultats
    num: 5,
  };

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error("❌ Serper status:", resp.status);
    return null;
  }

  const data = await resp.json();
  const organic = data.organic || [];
  if (!organic.length) return null;

  // On garde les 3 premiers résultats
  const top = organic.slice(0, 3);
  const summary = top
    .map((r, idx) => {
      const title = r.title || "";
      const snippet = r.snippet || "";
      const source = r.domain || r.link || "";
      return `[${idx + 1}] ${title}\n${snippet}\n(source : ${source})`;
    })
    .join("\n\n");

  return summary;
}

// 3) Essaie de répondre en utilisant Serper + OpenAI
async function maybeAnswerWithNews(question) {
  if (!needsFreshNews(question)) return null;
  if (!SERPER_API_KEY) return null;

  try {
    const webSummary = await callSerperSearch(question);
    if (!webSummary) return null;

    const messages = [
      {
        role: "system",
        content:
          "Tu es Philomène I.A., une assistante française. " +
          "Tu disposes d'informations d'actualité provenant d'Internet (Serper). " +
          "Utilise-les pour répondre de manière à jour, claire et prudente. " +
          "Si les infos ne sont pas claires ou se contredisent, dis-le.",
      },
      {
        role: "user",
        content:
          `Question de l'utilisateur : ${question}\n\n` +
          `Voici des informations récentes trouvées sur le web :\n` +
          `${webSummary}\n\n` +
          "Réponds en français, simplement, comme une assistante personnelle, " +
          "en citant les éléments importants (dates, pays, rôle des personnes).",
      },
    ];

    const answer = await askOpenAIText(messages);
    return answer || null;
  } catch (err) {
    console.error("🔥 Erreur maybeAnswerWithNews:", err);
    return null;
  }
}

// ------------------------------------------------------------
// ROUTES IA
// ------------------------------------------------------------

// Texte
app.post("/ask", async (req, res) => {
  try {
    const { conversation, userId, tokens } = req.body || {};
    const uid = userId || "guest";

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

    // 1️⃣ On mémorise le message dans l'historique
    pushToConversation(uid, "user", lastUserMessage);

    // 2️⃣ Si c’est une question d'actualité -> on tente Serper d'abord
    let answer = await maybeAnswerWithNews(lastUserMessage);

    // 3️⃣ Sinon, ou si Serper n'a rien donné, on reste sur le comportement normal
    if (!answer) {
      const fullHistory = getConversationHistory(uid);
      answer = await askOpenAIText(fullHistory);
    }

    // 4️⃣ On stocke la réponse et on renvoie
    pushToConversation(uid, "assistant", answer);

    res.json({ answer, tokensLeft: tokens });
  } catch (err) {
    console.error("🔥 Erreur /ask:", err);
    res.status(500).json({ error: "Erreur interne /ask." });
  }
});

// Image
app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    const uid = req.body?.userId || "guest";
    const userPrompt =
      req.body?.prompt || "Décris précisément l'image et à quoi elle sert.";

    if (!req.file) {
      return res.status(400).json({ error: "Aucune image reçue." });
    }

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
// LECTURE CODE-BARRES -> OpenFoodFacts (version v2 propre)
// ------------------------------------------------------------
app.get("/barcode", async (req, res) => {
  try {
    const code = (req.query.code || "").trim();

    if (!code) {
      return res.status(400).json({
        found: false,
        error: "Aucun code fourni.",
      });
    }

    const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json`;
    const resp = await fetch(url);

    if (!resp.ok) {
      console.error("OpenFoodFacts HTTP:", resp.status);
      return res.status(502).json({
        found: false,
        code,
        error: "Erreur OpenFoodFacts.",
      });
    }

    const data = await resp.json();

    if (!data || data.status !== 1 || !data.product) {
      return res.json({
        found: false,
        code,
        message: "Produit introuvable dans la base.",
      });
    }

    const p = data.product;

    res.json({
      found: true,
      code,
      name: p.product_name || p.generic_name || "",
      brand: p.brands || "",
      quantity: p.quantity || "",
      nutriscore: p.nutriscore_grade || null,
      nova: p.nova_group || null,
      eco_score: p.ecoscore_grade || null,
      image:
        p.image_front_small_url ||
        p.image_front_url ||
        p.image_url ||
        null,
    });
  } catch (err) {
    console.error("🔥 Erreur /barcode:", err);
    res.status(500).json({
      found: false,
      error: "Erreur serveur /barcode.",
    });
  }
});

// ------------------------------------------------------------
// CONFIG PUBLIQUE POUR LE FRONT (PayPal + crédits gratuits)
// ------------------------------------------------------------
app.get("/config", (_req, res) => {
  const paymentsEnabled = envTrue(PAYMENT_ENABLED) || envTrue(PAYMENTS_ENABLED);
  const paypalClientId = (PAYPAL_CLIENT_ID || "").trim().replace(/\s+/g, "");
  const mode = (PAYPAL_MODE || "sandbox").trim();

  const freeAnon = Number(FREE_ANON) || 0;
  const freeAfterSignup = Number(FREE_AFTER_SIGNUP) || 0;

  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });

  res.json({
    paymentsEnabled,
    paypalClientId,
    mode,
    freeAnon,
    freeAfterSignup,
  });
});

// ------------------------------------------------------------
// HEALTHCHECK
// ------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (GPT-4o, mémoire, tokens, actu Serper).");
});

// ------------------------------------------------------------
// LANCEMENT SERVEUR
// ------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Philomène backend démarré sur le port " + PORT);
  console.log("🧠 Models:", {
    text: OPENAI_MODEL_TEXT,
    vision: OPENAI_MODEL_VISION,
  });
});
