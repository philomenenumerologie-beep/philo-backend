// server.js
// Backend Philomène I.A. + Coach IA
// - /ask        : Philomène (conversation générale)
// - /coach      : Coach IA (assistant football)
// - /analyze-image : analyse d’image
// - /config     : infos publiques
// - Système de clés club avec limite d’appareils

import express from “express”;
import cors from “cors”;
import fetch from “node-fetch”;
import multer from “multer”;

try { await import(“dotenv”).then(m => m.default.config()); } catch {}

const app = express();
app.set(“trust proxy”, true);
app.use(express.json({ limit: “15mb” }));
app.use(express.urlencoded({ extended: true }));

const corsOpts = {
origin: “*”,
methods: [“POST”, “GET”, “OPTIONS”],
allowedHeaders: [“Content-Type”, “Authorization”],
};
app.use(cors(corsOpts));
app.options(”*”, cors(corsOpts));

const upload = multer({
storage: multer.memoryStorage(),
limits: { fileSize: 10 * 1024 * 1024 },
});

// ============================================================
// CONFIG ENV
// ============================================================
const {
OPENAI_API_KEY = “”,
OPENAI_MODEL_TEXT = “gpt-4o-mini”,
OPENAI_MODEL_VISION = “gpt-4o”,
FREE_ANON = “2000”,
FREE_AFTER_SIGNUP = “3000”,
PAYMENT_ENABLED,
PAYMENTS_ENABLED,
PAYPAL_CLIENT_ID = “”,
PAYPAL_MODE = “sandbox”,
} = process.env;

const envTrue = (v) => String(v ?? “”).trim().toLowerCase() === “true”;

if (!OPENAI_API_KEY) {
console.warn(“⚠️  OPENAI_API_KEY manquant.”);
}

// ============================================================
// CLUBS — Système de clés
// ============================================================
// Pour ajouter un club : ajoute une entrée ici
// Pour couper un club  : mets active: false
// maxUsers             : nombre max d’appareils autorisés
// ============================================================
const CLUBS = {
“DEMO-CLUB-0000”: {
nom: “Club Démo”,
maxUsers: 3,
active: true,
},
// Ajoute tes vrais clubs ici :
// “FC-TOURCOING-X7K2”: { nom: “FC Tourcoing”, maxUsers: 10, active: true },
// “AS-MOUSCRON-A3B9”: { nom: “AS Mouscron”, maxUsers: 15, active: true },
};

// Stockage des appareils par clé (en RAM)
// Structure : { “CLE”: Set([“deviceId1”, “deviceId2”, …]) }
const clubDevices = {};

function checkClubAccess(clubKey, deviceId) {
const club = CLUBS[clubKey];

if (!club) return { ok: false, reason: “Clé club invalide.” };
if (!club.active) return { ok: false, reason: “Abonnement expiré. Contactez votre administrateur.” };

if (!clubDevices[clubKey]) clubDevices[clubKey] = new Set();
const devices = clubDevices[clubKey];

// Appareil déjà enregistré → OK
if (devices.has(deviceId)) return { ok: true, club };

// Nouvel appareil → vérifier la limite
if (devices.size >= club.maxUsers) {
return {
ok: false,
reason: `Limite de ${club.maxUsers} utilisateurs atteinte pour ce club. Contactez votre administrateur.`,
};
}

// Nouvel appareil autorisé → on l’enregistre
devices.add(deviceId);
console.log(`✅ Nouvel appareil enregistré pour ${club.nom} (${devices.size}/${club.maxUsers})`);
return { ok: true, club };
}

// ============================================================
// MÉMOIRE DE CONVERSATION
// ============================================================
const conversations = {};

function getConversationHistory(userId, systemPrompt) {
if (!conversations[userId]) {
conversations[userId] = [{ role: “system”, content: systemPrompt }];
}
return conversations[userId];
}

function pushToConversation(userId, role, content) {
const history = conversations[userId];
if (!history) return;
history.push({ role, content });
const MAX = 60;
if (history.length > MAX) {
const sys = history[0];
conversations[userId] = [sys, …history.slice(-MAX + 1)];
}
}

// ============================================================
// PROMPTS
// ============================================================
const PROMPT_PHILOMENE =
“Tu es Philomène I.A., une assistante personnelle française. “ +
“Réponds clairement, simplement, sans blabla inutile. “ +
“Sois sympa et directe, avec des infos concrètes.”;

function getCoachPrompt(categorie) {
return `Tu es Coach IA, un assistant personnel pour entraîneurs de football amateur.
Catégorie active : ${categorie || “toutes catégories”}.

RÈGLES D’ADAPTATION PAR CATÉGORIE :

- U6/U7 → jeux simples, plaisir, pas de tactique, courtes durées
- U8/U9 → bases dribble, passe, petit terrain, exercices fun
- U10/U11 → début tactique, positions, foot à 8, schémas simples
- U12/U13 → tactique collective, pressing, transitions
- U14/U15 → schémas tactiques, phases de jeu, physique
- Seniors → tout niveau tactique et physique

POUR CHAQUE SÉANCE TU FOURNIS :

1. Échauffement avec durée
1. 2 ou 3 exercices principaux détaillés
1. Match final
1. Pour chaque exercice : nombre de joueurs, matériel nécessaire, durée, objectif, consignes simples à lire aux joueurs sur le terrain

FORMAT DES CONSIGNES :

- Courtes et simples, en langage parlé
- Maximum 4 lignes par exercice
- Comme si tu parlais directement aux joueurs

TU PEUX AUSSI :

- Rédiger des messages WhatsApp pour les parents (convocations, infos match, annulations)
- Donner des conseils en cas de blessure légère
- Suggérer des exercices physiques adaptés à l’âge
- Proposer des variantes si l’exercice est trop facile ou trop difficile

TU NE RÉPONDS PAS aux questions sans rapport avec le football ou le coaching sportif.`;
}

// ============================================================
// APPELS OPENAI
// ============================================================
async function askOpenAI(messages, model = OPENAI_MODEL_TEXT) {
const resp = await fetch(“https://api.openai.com/v1/chat/completions”, {
method: “POST”,
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
“Content-Type”: “application/json”,
},
body: JSON.stringify({ model, messages }),
});

if (!resp.ok) {
const err = await resp.text();
throw new Error(`OpenAI error ${resp.status}: ${err}`);
}

const data = await resp.json();
return data?.choices?.[0]?.message?.content?.trim() || “Pas de réponse.”;
}

async function askOpenAIVision({ question, dataUrl }) {
const messages = [
{
role: “system”,
content: “Tu es Philomène I.A., assistante française. Analyse l’image et explique clairement ce qu’il y a dessus.”,
},
{
role: “user”,
content: [
{ type: “text”, text: question || “Analyse l’image.” },
{ type: “image_url”, image_url: dataUrl },
],
},
];

const resp = await fetch(“https://api.openai.com/v1/chat/completions”, {
method: “POST”,
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
“Content-Type”: “application/json”,
},
body: JSON.stringify({ model: OPENAI_MODEL_VISION, messages }),
});

if (!resp.ok) throw new Error(`OpenAI vision error ${resp.status}`);
const data = await resp.json();
return data?.choices?.[0]?.message?.content?.trim() || “Impossible d’analyser.”;
}

// ============================================================
// ROUTES
// ============================================================

// — Philomène /ask —
app.post(”/ask”, async (req, res) => {
try {
const { conversation, userId } = req.body || {};
const uid = userId || “guest”;

```
let lastUserMessage = null;
if (Array.isArray(conversation)) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    if (msg.role === "user" && msg.content?.trim()) {
      lastUserMessage = msg.content.trim();
      break;
    }
  }
}

if (!lastUserMessage) return res.status(400).json({ error: "Pas de message." });

// Initialise la mémoire si besoin
if (!conversations[uid]) {
  conversations[uid] = [{ role: "system", content: PROMPT_PHILOMENE }];
}

pushToConversation(uid, "user", lastUserMessage);
const answer = await askOpenAI(conversations[uid]);
pushToConversation(uid, "assistant", answer);

res.json({ answer });
```

} catch (err) {
console.error(“🔥 /ask:”, err);
res.status(500).json({ error: “Erreur interne /ask.” });
}
});

// — Coach IA /coach —
app.post(”/coach”, async (req, res) => {
try {
const { message, userId, categorie, clubKey, deviceId } = req.body || {};

```
// Vérification clé club
if (!clubKey || !deviceId) {
  return res.status(401).json({ error: "Clé club ou identifiant appareil manquant." });
}

const access = checkClubAccess(clubKey, deviceId);
if (!access.ok) {
  return res.status(403).json({ error: access.reason });
}

if (!message?.trim()) return res.status(400).json({ error: "Pas de message." });

const uid = `coach_${userId || "guest"}`;
const systemPrompt = getCoachPrompt(categorie);

if (!conversations[uid]) {
  conversations[uid] = [{ role: "system", content: systemPrompt }];
}

// Mise à jour de la catégorie si elle change
conversations[uid][0] = { role: "system", content: systemPrompt };

pushToConversation(uid, "user", message.trim());
const answer = await askOpenAI(conversations[uid]);
pushToConversation(uid, "assistant", answer);

res.json({ answer, club: access.club.nom });
```

} catch (err) {
console.error(“🔥 /coach:”, err);
res.status(500).json({ error: “Erreur interne /coach.” });
}
});

// — Analyse image /analyze-image —
app.post(”/analyze-image”, upload.single(“image”), async (req, res) => {
try {
const uid = req.body?.userId || “guest”;
const userPrompt = req.body?.prompt || “Décris l’image.”;

```
if (!req.file) return res.status(400).json({ error: "Aucune image." });

const base64 = req.file.buffer.toString("base64");
const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

pushToConversation(uid, "user", `${userPrompt} [image]`);
const answer = await askOpenAIVision({ question: userPrompt, dataUrl });
pushToConversation(uid, "assistant", answer);

res.json({ answer });
```

} catch (err) {
console.error(“🔥 /analyze-image:”, err);
res.status(500).json({ error: “Erreur /analyze-image.” });
}
});

// — Config publique /config —
app.get(”/config”, (_req, res) => {
res.set({ “Cache-Control”: “no-store” });
res.json({
paymentsEnabled: envTrue(PAYMENT_ENABLED) || envTrue(PAYMENTS_ENABLED),
paypalClientId: (PAYPAL_CLIENT_ID || “”).trim(),
mode: (PAYPAL_MODE || “sandbox”).trim(),
freeAnon: Number(FREE_ANON) || 0,
freeAfterSignup: Number(FREE_AFTER_SIGNUP) || 0,
});
});

// — Admin : voir les clubs actifs (protégé par clé admin) —
app.get(”/admin/clubs”, (req, res) => {
const adminKey = req.headers[“x-admin-key”];
if (adminKey !== process.env.ADMIN_KEY) {
return res.status(403).json({ error: “Accès refusé.” });
}
const stats = {};
for (const [key, club] of Object.entries(CLUBS)) {
stats[key] = {
nom: club.nom,
maxUsers: club.maxUsers,
active: club.active,
currentUsers: clubDevices[key]?.size || 0,
};
}
res.json(stats);
});

// — Healthcheck —
app.get(”/”, (_req, res) => {
res.send(“✅ API Philomène I.A. + Coach IA en ligne.”);
});

// ============================================================
// LANCEMENT
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`🚀 Serveur démarré sur le port ${PORT}`);
console.log(`⚽ Coach IA actif — ${Object.keys(CLUBS).length} club(s) configuré(s)`);
console.log(`🧠 Models: text=${OPENAI_MODEL_TEXT} vision=${OPENAI_MODEL_VISION}`);
});
