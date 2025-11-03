// server.js
// Backend Philomène I.A.
// - /ask : conversation texte
// - /analyze-image : analyse d'image
// - mémoire de conversation par utilisateur
// - décompte des tokens côté front (le serveur ne bloque pas encore)
// ------------------------------------------------------------
//
// ATTENTION : tu dois avoir dans package.json :
// {
//   "name": "philomene-backend",
//   "version": "1.0.0",
//   "description": "API Philomène I.A. avec GPT-5, mémoire persistante et gestion des tokens.",
//   "type": "module",
//   "main": "server.js",
//   "scripts": {
//     "start": "node server.js"
//   },
//   "dependencies": {
//     "express": "^4.19.0",
//     "cors": "^2.8.5",
//     "node-fetch": "^3.3.2",
//     "multer": "^1.4.5-lts.1"
//   }
// }
//
// Et dans Render :
//  - PORT est fourni automatiquement
//  - OPENAI_API_KEY est défini dans "Environment Variables"
// ------------------------------------------------------------

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";

const app = express();

// ===========================
// CONFIG GÉNÉRALE
// ===========================

// Ta clé OpenAI (doit être mise dans Render → Environment → OPENAI_API_KEY)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "A_METTRE_DANS_RENDER";

// Choix des modèles utilisés
// Texte pur
const OPENAI_MODEL_TEXT = "gpt-4o-mini"; // tu peux plus tard mettre ton modèle GPT-5 ici
// Vision (analyse d'image)
const OPENAI_MODEL_VISION = "gpt-4o-mini"; // idem

// Limites d'upload
app.use(express.json({ limit: "15mb" }));

// Multer pour réceptionner les images envoyées par le front
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB max par image
  }
});

// CORS : autorise seulement ton site
app.use(
  cors({
    origin: [
      "https://philomeneia.com",
      "https://www.philomeneia.com"
    ],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// ===========================
// MÉMOIRE DE CONVERSATION
// ===========================
//
// conversations[userId] = [
//   { role:"system", content:"..." },
//   { role:"user", content:"..." },
//   { role:"assistant", content:"..." },
//   ...
// ]
//
// NOTE : c'est en RAM. Donc si Render redémarre, la mémoire repart à zéro.
// Plus tard on pourra la mettre en base SQLite ou autre.
//
const conversations = {};

function getConversationHistory(userId) {
  if (!conversations[userId]) {
    conversations[userId] = [
      {
        role: "system",
        content:
          "Tu es Philomène I.A., une assistante personnelle française. " +
          "Tu réponds clairement, simplement, sans blabla inutile. " +
          "Tu peux être sympa et directe. " +
          "Tu donnes des infos concrètes et pratiques. " +
          "Tu restes polie et tu évites les phrases trop longues."
      }
    ];
  }
  return conversations[userId];
}

function pushToConversation(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });

  // On limite la taille mémoire par utilisateur pour éviter que ça explose.
  // On garde le message system + les ~30 derniers tours.
  const MAX_MESSAGES = 60; // total (system + échanges)
  if (history.length > MAX_MESSAGES) {
    const systemMsg = history[0]; // on garde la première consigne
    const lastMsgs = history.slice(-MAX_MESSAGES + 1);
    conversations[userId] = [systemMsg, ...lastMsgs];
  }
}

// ===========================
// APPEL OPENAI (TEXTE)
// ===========================
//
// On envoie l'historique complet du user à OpenAI.
// IMPORTANT : pas de "temperature" custom ici car le modèle actuel
// n'accepte pas de valeur différente de la valeur par défaut.
// (c'était ton erreur 'Unsupported value: temperature')
//
async function askOpenAIText(messages) {
  const body = {
    model: OPENAI_MODEL_TEXT,
    messages
    // PAS de "temperature": 0.7
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const textErr = await resp.text();
    console.error("❌ OpenAI /text status:", resp.status);
    console.error("❌ OpenAI /text body:", textErr);
    throw new Error("Erreur API OpenAI (texte)");
  }

  const data = await resp.json();

  const answer =
    data?.choices?.[0]?.message?.content?.trim() ||
    "Je suis désolée, je n'ai pas pu générer de réponse.";

  return answer;
}

// ===========================
// APPEL OPENAI (VISION / IMAGE)
// ===========================
//
// On fabrique un message 'user' qui contient :
// - du texte (la question de l'utilisateur genre 'Décris moi la machine')
// - l'image encodée en base64 sous forme d'URL data:...
//
// Pareil : PAS de 'temperature' custom.
//
async function askOpenAIVision({ question, dataUrl }) {
  const messages = [
    {
      role: "system",
      content:
        "Tu es Philomène I.A., assistante française. " +
        "Tu regardes l'image fournie par l'utilisateur et tu expliques clairement " +
        "ce qu'il y a dessus. Si tu n'es pas sûre, tu le dis."
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            question ||
            "Analyse l'image. Dis-moi ce que tu vois et à quoi ça sert."
        },
        {
          type: "image_url",
          image_url: dataUrl
        }
      ]
    }
  ];

  const body = {
    model: OPENAI_MODEL_VISION,
    messages
    // PAS de "temperature"
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const textErr = await resp.text();
    console.error("❌ OpenAI /vision status:", resp.status);
    console.error("❌ OpenAI /vision body:", textErr);
    throw new Error("Erreur API OpenAI (vision)");
  }

  const data = await resp.json();

  const answer =
    data?.choices?.[0]?.message?.content?.trim() ||
    "J'ai bien reçu l'image mais je n'ai pas pu l'analyser.";

  return answer;
}

// ===========================
// ROUTE /ask
// ===========================
//
// Le front envoie :
// {
//   conversation: [...],  // historique local (on ne fait plus confiance 100%, on prend juste le dernier user message)
//   userId: "guest" OU un vrai id,
//   tokens: 980            // le solde estimé côté front (info facultative)
// }
//
// Le backend :
// 1. récupère le dernier message user
// 2. l'ajoute dans la mémoire du serveur
// 3. envoie toute la mémoire user -> OpenAI
// 4. ajoute la réponse en mémoire
// 5. renvoie { answer, tokensLeft }
app.post("/ask", async (req, res) => {
  try {
    const { conversation, userId, tokens } = req.body || {};
    const uid = userId || "guest";

    // On chope le dernier message utilisateur depuis ce que le front nous a envoyé.
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
      return res.status(400).json({
        error: "Pas de message utilisateur reçu."
      });
    }

    // On stocke le dernier message utilisateur dans la mémoire backend
    pushToConversation(uid, "user", lastUserMessage);

    // On récupère l'historique complet (system + tout)
    const fullHistory = getConversationHistory(uid);

    // On demande la réponse à OpenAI avec tout l'historique
    const answer = await askOpenAIText(fullHistory);

    // On stocke aussi la réponse dans la mémoire
    pushToConversation(uid, "assistant", answer);

    // On renvoie la réponse
    // tokensLeft : pour l'instant on renvoie ce que le front nous a dit.
    // (le vrai blocage de tokens se fera plus tard côté serveur si tu veux)
    res.json({
      answer,
      tokensLeft: tokens
    });
  } catch (err) {
    console.error("🔥 Erreur /ask:", err);
    return res.status(500).json({
      error: "Erreur interne /ask."
    });
  }
});

// ===========================
// ROUTE /analyze-image
// ===========================
//
// Form-data attendu (multipart/form-data) :
//   - "image": le fichier (photo, screenshot, etc.)
//   - "userId": identifiant user ou "guest"
//   - "prompt": texte optionnel ("Qu'est-ce que c'est cette machine ?")
//
// Étapes :
// 1. on convertit l'image reçue en base64 -> data URL
// 2. on prépare la question
// 3. on envoie à askOpenAIVision()
// 4. on sauvegarde question/réponse dans la mémoire
//
app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    const uid = req.body?.userId || "guest";
    const userPrompt =
      req.body?.prompt ||
      "Décris-moi précisément l'image et dis-moi à quoi elle sert.";

    if (!req.file) {
      return res.status(400).json({ error: "Aucune image reçue." });
    }

    // On convertit le binaire reçu en base64 + data URL
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // On push dans la mémoire du user : il a demandé une analyse d'image
    pushToConversation(
      uid,
      "user",
      `${userPrompt} [image envoyée]`
    );

    // On interroge le modèle vision
    const visionAnswer = await askOpenAIVision({
      question: userPrompt,
      dataUrl
    });

    // On stocke la réponse dans la mémoire
    pushToConversation(uid, "assistant", visionAnswer);

    // On renvoie la réponse vision
    res.json({
      answer: visionAnswer
    });
  } catch (err) {
    console.error("🔥 Erreur /analyze-image:", err);
    return res.status(500).json({
      error: "Erreur interne /analyze-image."
    });
  }
});

// ===========================
// HEALTHCHECK /
// ===========================
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (GPT-5, mémoire persistante, tokens réels).");
});

// ===========================
// LANCEMENT SERVEUR
// ===========================
//
// Render va donner PORT dans les vars d'env.
// En local tu peux faire `PORT=10000 node server.js`
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Philomène backend démarré sur le port " + PORT);
});
