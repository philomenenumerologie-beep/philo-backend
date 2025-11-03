// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { fileURLToPath } from "url";
import path from "path";

// =======================
// CONFIG DE BASE
// =======================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini"; // tu pourras mettre ton modèle "GPT-5" ici plus tard

// Création Express
const app = express();

app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "15mb" }));

// =======================
// SQLITE (mémoire persistante)
// =======================
//
// On stocke tous les messages dans une base locale "memory.db"
// Schéma : messages(userId, ts, role, content)
//
// Avantages :
// - On se souvient des users même après redémarrage
// - Pas besoin de tout garder en RAM
//
// On limitera à 40 derniers messages par utilisateur (≈ 20 tours).
//

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "memory.db");

let db;

// ouverture de la base sqlite et création table si pas existe
async function initDB() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // table messages
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

// récupérer les 40 derniers messages d'un user, triés du plus vieux au plus récent
async function getUserHistory(userId) {
  if (!userId) userId = "guest";

  // on prend les 40 derniers messages
  const rows = await db.all(
    `
    SELECT role, content, ts
    FROM messages
    WHERE userId = ?
    ORDER BY ts DESC
    LIMIT 40
    `,
    [userId]
  );

  // rows est "du plus récent au plus vieux", on les remet dans l'ordre normal (ancien -> récent)
  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content,
    ts: r.ts
  }));
}

// ajoute un message dans la base
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

  // après insertion, on limite l'historique à 40 derniers messages
  await trimHistory(userId);
}

// garde seulement les 40 messages les + récents pour ce user
async function trimHistory(userId) {
  if (!userId) userId = "guest";

  // on récupère les id triés du plus récent au plus vieux
  const rows = await db.all(
    `
    SELECT id
    FROM messages
    WHERE userId = ?
    ORDER BY ts DESC
    `,
    [userId]
  );

  // si 40 ou moins => rien à faire
  if (rows.length <= 40) return;

  // tous les messages qu'on DOIT supprimer = du 41ème jusqu'au dernier
  const toDelete = rows.slice(40);

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
// Le front t'envoie :
// {
//   conversation: [...],   // il l'envoie encore mais on va surtout prendre le dernier message user
//   userId: "xxx" ou "guest",
//   tokens: 12345
// }
//
// On fait :
// - On va chercher l'historique en base (jusqu'à 40 messages récents)
// - On ajoute le nouveau message user dedans et on le stocke en base
// - On envoie tout ça à OpenAI
// - On reçoit la réponse IA
// - On stocke aussi la réponse IA en base
// - On calcule combien de tokens consommer (juste la réponse IA = completion_tokens)
// - On renvoie new_balance au front
//
app.post("/ask", async (req, res) => {
  try {
    const { userId, tokens, conversation } = req.body;

    // solde actuel vu par le front
    const previousBalance =
      (typeof tokens === "number" && tokens >= 0) ? tokens : 0;

    // 1. récupérer l'historique en base
    let history = await getUserHistory(userId);

    // 2. trouver le dernier message user envoyé dans cette requête
    let latestUserMsg = null;
    if (Array.isArray(conversation)) {
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

    // 3. on ajoute ce message user en base et dans l'historique mémoire qu'on va envoyer à l'IA
    await addMessage(userId, "user", latestUserMsg);
    history.push({ role: "user", content: latestUserMsg });

    // 4. appel OpenAI avec l'historique mis à jour
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

    // 5. réponse texte de l'IA
    const answer = data.choices[0].message?.content || "";

    // 6. on stocke la réponse de l'assistante dans la base
    await addMessage(userId, "assistant", answer);

    // 7. tokens consommés = seulement la sortie IA
    const completionTokens =
      (data.usage && (data.usage.completion_tokens || data.usage.completionTokens)) || 0;

    const consumedTokens = Math.max(1, completionTokens);

    let newBalance = previousBalance - consumedTokens;
    if (newBalance < 0) newBalance = 0;

    // 8. on renvoie au front ce qu'il attend
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

// simple check route
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne (mémoire persistante activée).");
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
