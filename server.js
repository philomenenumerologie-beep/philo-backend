// server.js
// Backend Philomene I.A. + Coach IA
// Deux appels OpenAI separes : texte + schema

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";

const app = express();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_TEXT = "gpt-4o-mini";
const OPENAI_MODEL_VISION = "gpt-4o-mini";

const {
  FREE_ANON = "2000",
  FREE_AFTER_SIGNUP = "3000",
  PAYMENT_ENABLED,
  PAYMENTS_ENABLED,
  PAYPAL_CLIENT_ID = "",
  PAYPAL_MODE = "sandbox",
} = process.env;

const envTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";

app.use(cors({
  origin: "*",
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));
const upload = multer({ storage: multer.memoryStorage() });

const CLUBS = {
  "DEMO-CLUB-0000": { nom: "Club Demo", maxUsers: 3, active: true },
};

const clubDevices = {};

function checkClubAccess(clubKey, deviceId) {
  const club = CLUBS[clubKey];
  if (!club) return { ok: false, reason: "Cle club invalide." };
  if (!club.active) return { ok: false, reason: "Abonnement expire." };
  if (!clubDevices[clubKey]) clubDevices[clubKey] = new Set();
  const devices = clubDevices[clubKey];
  if (devices.has(deviceId)) return { ok: true, club };
  if (devices.size >= club.maxUsers) {
    return { ok: false, reason: "Limite atteinte. Contactez votre administrateur." };
  }
  devices.add(deviceId);
  return { ok: true, club };
}
const conversations = {};

function getConversationHistory(userId) {
  if (!conversations[userId]) {
    conversations[userId] = [{
      role: "system",
      content: "Tu es Philomene I.A., une assistante personnelle francaise. Tu es claire, utile, concrete."
    }];
  }
  return conversations[userId];
}

function pushToConversation(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  const MAX_TURNS = 30;
  if (history.length > MAX_TURNS) {
    const sys = history[0];
    const last = history.slice(-MAX_TURNS + 1);
    conversations[userId] = [sys, ...last];
  }
}

function getCoachTextPrompt(categorie) {
  const cat = categorie || "toutes categories";
  let p = "Tu es Coach IA, un assistant pour entraineurs de football amateur. ";
  p += "Categorie : " + cat + ". ";
  p += "U6/U7: jeux simples. U8/U9: dribble passe. U10/U11: tactique foot a 8. ";
  p += "U12/U13: pressing. U14/U15: schemas. U16-U18: niveau avance. Seniors: tout. ";
  p += "Pour chaque seance : echauffement, 2-3 exercices detailles, match final. ";
  p += "Pour chaque exercice : joueurs, materiel, duree, objectif, consignes simples. ";
  p += "Reponds UNIQUEMENT avec le texte de la seance. Pas de JSON, pas de code.";
  return p;
}

function getSchemaPrompt(exerciceText) {
  let p = "Tu es un assistant qui genere uniquement du JSON pour des schemas d'exercices de football. ";
  p += "Voici un exercice : " + exerciceText + ". ";
  p += "Genere un JSON valide avec ce format exact : ";
  p += '{"type":"triangle","players":[{"id":"J1","x":50,"y":20},{"id":"J2","x":20,"y":70},{"id":"J3","x":80,"y":70}],';
  p += '"plots":[{"x":50,"y":20},{"x":20,"y":70},{"x":80,"y":70}],';
  p += '"ball_paths":[{"from":"J1","to":"J2","style":"dashed"}],';
  p += '"player_paths":[{"from":"J2","to":"J3","style":"solid"}],';
  p += '"goal":null,"distance":"7m entre les plots","description":"Description courte"}. ';
  p += "Types possibles : triangle, slalom, carre, ligne, rondo, dribble_but. ";
  p += "Pour dribble_but ajoute goal:{x:50,y:5}. ";
  p += "Coordonnees x et y entre 15 et 85. Joueurs bien espaces. ";
  p += "Reponds UNIQUEMENT avec le JSON, rien d'autre.";
  return p;
}
async function askOpenAI(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: OPENAI_MODEL_TEXT, messages, temperature: 0.7 })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error("Erreur OpenAI: " + txt);
  }
  const data = await resp.json();
  return data.choices[0].message.content.trim() || "Pas de reponse.";
}

async function askOpenAIVision(question, dataUrl) {
  const messages = [
    { role: "system", content: "Tu es Philomene I.A. Tu analyses l'image clairement." },
    { role: "user", content: [
      { type: "text", text: question || "Analyse l'image." },
      { type: "image_url", image_url: dataUrl }
    ]}
  ];
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: OPENAI_MODEL_VISION, messages, temperature: 0.4 })
  });
  if (!resp.ok) throw new Error("Erreur OpenAI vision");
  const data = await resp.json();
  return data.choices[0].message.content.trim() || "Impossible d'analyser.";
}

async function generateSchema(exerciceText) {
  try {
    const messages = [
      { role: "user", content: getSchemaPrompt(exerciceText) }
    ];
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL_TEXT, messages, temperature: 0.2 })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data.choices[0].message.content.trim();
    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.warn("Schema generation failed:", e);
    return null;
  }
}
app.post("/ask", async (req, res) => {
  try {
    const { conversation, userId, tokens } = req.body || {};
    const uid = userId || "guest";
    let lastUserMessage = null;
    if (Array.isArray(conversation)) {
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i].role === "user") {
          lastUserMessage = conversation[i].content;
          break;
        }
      }
    }
    if (!lastUserMessage || !lastUserMessage.trim()) {
      return res.status(400).json({ error: "Pas de message." });
    }
    pushToConversation(uid, "user", lastUserMessage);
    const fullHistory = getConversationHistory(uid);
    const answer = await askOpenAI(fullHistory);
    pushToConversation(uid, "assistant", answer);
    res.json({ answer, tokensLeft: tokens });
  } catch (err) {
    console.error("Erreur /ask:", err);
    res.status(500).json({ error: "Erreur interne /ask." });
  }
});

app.post("/coach", async (req, res) => {
  try {
    const { message, userId, categorie, clubKey, deviceId } = req.body || {};
    if (!clubKey || !deviceId) {
      return res.status(401).json({ error: "Cle club manquante." });
    }
    const access = checkClubAccess(clubKey, deviceId);
    if (!access.ok) {
      return res.status(403).json({ error: access.reason });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Pas de message." });
    }
    const uid = "coach_" + (userId || "guest");
    const systemPrompt = getCoachTextPrompt(categorie);
    if (!conversations[uid]) {
      conversations[uid] = [{ role: "system", content: systemPrompt }];
    } else {
      conversations[uid][0] = { role: "system", content: systemPrompt };
    }
    pushToConversation(uid, "user", message.trim());
    const answer = await askOpenAI(conversations[uid]);
    pushToConversation(uid, "assistant", answer);
    const hasExercise = answer.toLowerCase().includes("exercice") ||
      answer.toLowerCase().includes("echauffement") ||
      answer.toLowerCase().includes("seance");
    let schema = null;
    if (hasExercise) {
      schema = await generateSchema(answer);
    }
    res.json({ answer, schema, club: access.club.nom });
  } catch (err) {
    console.error("Erreur /coach:", err);
    res.status(500).json({ error: "Erreur interne /coach." });
  }
});
app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    const uid = req.body.userId || "guest";
    const userPrompt = req.body.prompt || "Decris l'image.";
    if (!req.file) return res.status(400).json({ error: "Aucune image." });
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUrl = "data:" + mimeType + ";base64," + base64;
    pushToConversation(uid, "user", userPrompt + " [image]");
    const visionAnswer = await askOpenAIVision(userPrompt, dataUrl);
    pushToConversation(uid, "assistant", visionAnswer);
    res.json({ answer: visionAnswer });
  } catch (err) {
    console.error("Erreur /analyze-image:", err);
    res.status(500).json({ error: "Erreur interne." });
  }
});
app.post("/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From || "inconnu";
  const body = req.body.Body || "";
  
  if (!body.trim()) {
    return res.set("Content-Type", "text/xml").send(`<Response></Response>`);
  }

  pushToConversation(from, "user", body);
  const history = getConversationHistory(from);
  const answer = await askOpenAI(history);
  pushToConversation(from, "assistant", answer);

  res.set("Content-Type", "text/xml").send(`
    <Response><Message>${answer}</Message></Response>
  `);
});

app.get("/config", (_req, res) => {
  res.set({ "Cache-Control": "no-store" });
  res.json({
    paymentsEnabled: envTrue(PAYMENT_ENABLED) || envTrue(PAYMENTS_ENABLED),
    paypalClientId: (PAYPAL_CLIENT_ID || "").trim(),
    mode: (PAYPAL_MODE || "sandbox").trim(),
    freeAnon: Number(FREE_ANON) || 0,
    freeAfterSignup: Number(FREE_AFTER_SIGNUP) || 0,
  });
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Philomene I.A. + Coach IA en ligne" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Philomene + Coach IA demarre sur le port " + PORT);
  console.log("Clubs: " + Object.keys(CLUBS).join(", "));
});
