// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { fileURLToPath } from "url";
import path from "path";

// =======================
// CONFIG
// =======================

// IMPORTANT : ta clé OpenAI doit être définie dans Render
// comme variable d'environnement OPENAI_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// On sert bien le modèle premium que tu vends comme "GPT-5"
const OPENAI_MODEL = "gpt-5";

// Nombre maximum de messages mémorisés par utilisateur
// 40 messages = ~20 allers/retours récents
const MAX_HISTORY_MESSAGES = 40;

// =======================
// EXPRESS SETUP
// =======================
const app = express();

app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type"]
}));

// on accepte des payloads un peu gros pour plus tard (images encodées, etc.)
app.use(express.json({ limit: "15mb" }));

// =======================
// SQLITE SETUP (mémoire persistante)
// =======================
//
// On stocke chaque message échangé entre un user et Philomène
// dans une base SQLite locale "memory.db".
//
// Schéma table:
//
// messages(
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   userId TEXT NOT NULL,
//   ts INTEGER NOT NULL,
//   role TEXT NOT NULL,        // "user" ou "assistant"
//   content TEXT NOT NULL
// )
//
// => Avantage :
// - Mémoire par utilisateur qui survit aux redémarrages Render
// - On peut recharger le contexte à chaque question pour qu'elle se "souvienne"
//

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "memory.db");

let db;

// ouvre/initialise la base
async function initDB() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
}

// récupère historique récent pour un user, en ordre chronologique
async function getUserHistory(userId) {
  if (!userId) userId = "guest";

  // Récupère les 40 derniers messages de ce user (par timestamp DESC)
  const rows = await db.all(
    `
    SELECT role, content, ts
    FROM messages
    WHERE userId = ?
    ORDER BY ts DESC
    LIMIT ?
    `,
    [userId, MAX_HISTORY_MESSAGES]
  );

  // rows est du plus récent -> plus vieux, on renverse
  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content,
    ts: r.ts
  }));
}

// ajoute UN message en base
async function addMessage(userId, role, content) {
  if (!userId) userId = "guest";
  const now = Date.now();

  await db.run(
    `
    INSERT INTO messages (userId, ts, role, content)
    VALUES (?, ?, ?, ?)
    `,
    [userId, now, role, content]
  );

  // Après insertion, on limite le total aux MAX_HISTORY_MESSAGES derniers
  await trimHistory(userId);
}

// garde seulement les MAX_HISTORY_MESSAGES plus récents pour ce user
async function trimHistory(userId) {
  if (!userId) userId = "guest";

  // on chope tous les id du plus récent au plus vieux
  const rows = await db.all(
    `
    SELECT id
    FROM messages
    WHERE userId = ?
    ORDER BY ts DESC
    `,
    [userId]
  );

  if (rows.length <= MAX_HISTORY_MESSAGES) return;

  // tous les messages en trop, à effacer
  const toDelete = rows.slice(MAX_HISTORY_MESSAGES); // tout après le plus récent bloc

  const ids = toDelete.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");

  await db.run(
    `DELETE FROM messages WHERE id IN (${placeholders})`,
    ids
  );
}

// =======================
// ROUTE /ask
// =======================
//
// Le front envoie :
// {
//   userId: "xxx" ou "guest",
//   tokens: 1234567,             // solde affiché côté front AVANT demande
//   conversation: [ ... ]        // historique côté front (on va juste s'en servir
//                                // pour choper le dernier message user envoyé)
// }
//
// Nous on fait :
// 1. On récupère l'historique stocké en base pour ce user
// 2. On extrait le DERNIER message "user" fourni par le front
// 3. On l'ajoute en base
// 4. On envoie tout l'historique (limité) à OpenAI GPT-5
// 5. On stocke la réponse assistant en base
// 6. On calcule combien de tokens ont été VRAIMENT utilisés
//    -> on utilise *total_tokens*, pas juste la sortie
//    -> total_tokens inclut texte utilisateur, historique envoyé,
//       réponse IA, vision, doc, etc.
//    => c'est EXACTEMENT ce que tu veux : "tout ce que tu fais, c'est ton compteur"
// 7. On renvoie la réponse + le nouveau solde
//
app.post("/ask", async (req, res) => {
  try {
    const { userId, tokens, conversation } = req.body;

    // solde vu par le front avant la requête
    const previousBalance =
      (typeof tokens === "number" && tokens >= 0) ? tokens : 0;

    // 1. charger la mémoire persistante de cet utilisateur
    let history = await getUserHistory(userId);

    // 2. récupérer le dernier message USER envoyé depuis le front
    //    (c'est le texte qu'il vient d'écrire)
    let latestUserMsg = null;
    if (Array.isArray(conversation)) {
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i].role === "user") {
          latestUserMsg = conversation[i].content;
          break;
        }
      }
    }

    if (
      !latestUserMsg ||
      typeof latestUserMsg !== "string" ||
      latestUserMsg.trim() === ""
    ) {
      return res.status(400).json({ error: "Aucun message utilisateur valide reçu." });
    }

    // 3. on ajoute ce message user dans la base ET dans l'historique qu'on va envoyer à OpenAI
    await addMessage(userId, "user", latestUserMsg);
    history.push({ role: "user", content: latestUserMsg });

    // 4. appel OpenAI GPT-5 avec tout l'historique récent
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const data = await openaiResp.json();

    if (!data || !data.choices || !data.choices[0]) {
      console.error("Réponse OpenAI inattendue:", data);
      return res.status(500).json({ error: "Réponse invalide d'OpenAI." });
    }

    // 5. texte de la réponse IA (Philomène)
    const answer = data.choices[0].message?.content || "";

    // on sauvegarde aussi la réponse assistante dans la base
    await addMessage(userId, "assistant", answer);

    // 6. calcul des tokens consommés
    //
    // ICI point TRÈS IMPORTANT :
    // on prend usage.total_tokens
    // => ça inclut tout : prompt + historique + sortie + vision + doc
    // => donc si l'utilisateur envoie une photo, un PDF énorme,
    //    c'est LUI qui paie en jetons (pas toi manuellement)
    //
    const usage = data.usage || {};
    const totalTokensUsed =
      usage.total_tokens ??
      usage.totalTokens ??
      (
        (usage.prompt_tokens || usage.promptTokens || 0) +
        (usage.completion_tokens || usage.completionTokens || 0)
      );

    // sécurité : au moins 1 token consommé
    const consumedTokens = Math.max(1, totalTokensUsed);

    // 7. calcul du nouveau solde utilisateur
    let newBalance = previousBalance - consumedTokens;
    if (newBalance < 0) newBalance = 0;

    // 8. renvoyer tout ça au front
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

// route de test basique
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (GPT-5, mémoire persistante, tokens réels).");
});

// =======================
// LANCEMENT SERVEUR
// =======================
const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Philomène API en ligne sur le port " + PORT);
  });
}).catch(err => {
  console.error("Erreur initDB:", err);
});
