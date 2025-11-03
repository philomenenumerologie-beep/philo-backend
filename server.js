import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

/* =========================
   CHEMINS FICHIERS (memory)
   ========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEMORY_FILE = path.join(__dirname, "memory.json");

/* =========================
   CONFIG GLOBALE
   ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini"; // remplace plus tard par ton modèle "GPT-5"
const ADMIN_KEY = process.env.ADMIN_KEY || "philoadmin123";

/* =========================
   MIDDLEWARE
   ========================= */
app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type", "x-admin-key"]
}));

app.use(express.json({ limit: "15mb" })); // on autorise du texte assez gros

/* =========================
   MEMORY MANAGEMENT
   ========================= */

/**
 * Charge le JSON de mémoire depuis memory.json
 * Format:
 * {
 *   "userId1": [
 *     { role: "user", content: "..." },
 *     { role: "assistant", content: "..." },
 *     ...
 *   ],
 *   "userId2": [ ... ]
 * }
 */
function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "{}", "utf8");
    }
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (err) {
    console.error("Erreur loadMemory:", err);
    return {};
  }
}

/**
 * Sauvegarde la mémoire complète sur disque
 */
function saveMemory(memoryObj) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryObj, null, 2), "utf8");
  } catch (err) {
    console.error("Erreur saveMemory:", err);
  }
}

/**
 * Récupère l'historique pour 1 user
 * On limite à 40 derniers messages (≈20 tours utilisateur+IA)
 */
function getUserHistory(memoryObj, userId) {
  if (!userId) userId = "guest";
  const full = memoryObj[userId] || [];
  // On prend les 40 derniers messages pour pas exploser les coûts
  return full.slice(-40);
}

/**
 * Ajoute un message au fil du user ("user" ou "assistant")
 * Puis re-tronque pour garder que les derniers 40
 */
function pushToUserHistory(memoryObj, userId, role, content) {
  if (!userId) userId = "guest";
  if (!memoryObj[userId]) {
    memoryObj[userId] = [];
  }
  memoryObj[userId].push({ role, content });

  // limite dure: 40 derniers messages max
  if (memoryObj[userId].length > 40) {
    memoryObj[userId] = memoryObj[userId].slice(-40);
  }
}

/* =========================
   USAGE LOG (admin)
   ========================= */

const usageLog = {};
function logUsage(userId, usedTokens, newBalance) {
  if (!userId) userId = "unknown";
  if (!usageLog[userId]) usageLog[userId] = [];

  usageLog[userId].push({
    ts: Date.now(),       // ms timestamp
    used: usedTokens,     // tokens cramés par cette réponse
    remaining: newBalance // solde restant après
  });

  // garde max 100 entrées par user en mémoire
  if (usageLog[userId].length > 100) {
    usageLog[userId].shift();
  }
}

/* =========================
   ROUTE /ask
   =========================
   Le front envoie :
   {
     conversation: [...],    // il envoie tjs ça mais on va bientôt l'ignorer pour la mémoire
     userId: "xxx" ou "guest",
     tokens: 12345           // solde actuel affiché côté front
   }

   Retour:
   {
     answer: "...",
     used_tokens: 123,
     new_balance: 12000,
     usage: { ... }          // debug OpenAI
   }

   GROS CHANGEMENT ICI :
   - On n'utilise plus la "conversation" du front comme vérité.
     => On construit NOUS l'historique du user avec memory.json
*/
app.post("/ask", async (req, res) => {
  try {
    const { userId, tokens, conversation } = req.body;

    // 1. On charge toute la mémoire actuelle
    const memory = loadMemory();

    // 2. On récupère l'historique pour ce user
    let history = getUserHistory(memory, userId);

    // 3. On prend juste le dernier message utilisateur du front
    //    (c'est ce qu'il vient d'écrire à Philomène)
    //    Dans ton front, tu push() le message user juste avant d'appeler /ask
    //    donc on peut le retrouver en regardant le dernier "user" dans `conversation`
    let latestUserMsg = null;
    if (Array.isArray(conversation)) {
      // On cherche le dernier élément avec role === "user"
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i].role === "user") {
          latestUserMsg = conversation[i].content;
          break;
        }
      }
    }

    if (!latestUserMsg || typeof latestUserMsg !== "string" || latestUserMsg.trim() === "") {
      return res.status(400).json({ error: "Aucun message utilisateur valide reçu." });
    }

    // 4. On ajoute ce nouveau message user dans l'historique interne
    pushToUserHistory(memory, userId, "user", latestUserMsg);

    // 5. On recharge l'historique à jour pour construire ce qu'on envoie à OpenAI
    history = getUserHistory(memory, userId);

    // 6. Appel OpenAI avec cet historique
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: history.map(m => ({
          role: m.role,
          content: m.content
        })),
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!data || !data.choices || !data.choices[0]) {
      console.error("Réponse OpenAI inattendue:", data);
      return res.status(500).json({ error: "Réponse invalide d'OpenAI." });
    }

    const answer = data.choices[0].message?.content || "";

    // 7. On ajoute la réponse assistant dans la mémoire de ce user
    pushToUserHistory(memory, userId, "assistant", answer);

    // 8. On sauvegarde toute la mémoire sur disque
    saveMemory(memory);

    // 9. FACTURATION TOKENS
    // on facture SEULEMENT la réponse IA (completion_tokens)
    const completionTokens =
      (data.usage && (data.usage.completion_tokens || data.usage.completionTokens)) || 0;

    const consumedTokens = Math.max(1, completionTokens);

    // solde actuel envoyé par le front
    const previousBalance =
      (typeof tokens === "number" && tokens >= 0) ? tokens : 0;

    let newBalance = previousBalance - consumedTokens;
    if (newBalance < 0) newBalance = 0;

    // 10. Log admin en mémoire
    logUsage(userId || "guest", consumedTokens, newBalance);

    // 11. Réponse finale envoyée au front
    return res.json({
      answer,
      used_tokens: consumedTokens,
      new_balance: newBalance,
      usage: data.usage || {}
    });

  } catch (err) {
    console.error("Erreur /ask:", err);
    return res.status(500).json({ error: "Erreur serveur interne." });
  }
});

/* =========================
   ROUTE ADMIN /admin/usage
   =========================
   - te donne la conso par user
   - il faut envoyer le header x-admin-key
*/
app.get("/admin/usage", (req, res) => {
  const providedKey = req.headers["x-admin-key"];
  if (providedKey !== ADMIN_KEY) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  // On résume ce qu'on sait pour chaque user
  const summary = {};
  for (const userId of Object.keys(usageLog)) {
    const entries = usageLog[userId];
    if (!entries || entries.length === 0) continue;

    const totalUsed = entries.reduce((sum, e) => sum + e.used, 0);
    const last = entries[entries.length - 1];

    summary[userId] = {
      total_used_tokens: totalUsed,
      last_remaining_tokens: last.remaining,
      last_activity_ts: last.ts,
      history: entries
    };
  }

  return res.json({
    ok: true,
    summary
  });
});

/* =========================
   PING /
   ========================= */
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (mémoire activée).");
});

/* =========================
   START SERVER
   ========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Philomène API en ligne sur le port " + PORT);
});
