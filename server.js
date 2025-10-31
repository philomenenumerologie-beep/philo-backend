// server.js
// Backend Philomène IA
// - Mémoire par utilisateur
// - Décompte de tokens
// - GPT-4-Turbo
// - Prêt pour Clerk

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ============================
// CONFIG
// ============================
const PORT = process.env.PORT || 10000;

// clé OpenAI (tu l'as déjà mise dans Render > Environment sous OPENAI_API_KEY)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// modèle IA qu'on utilise
const OPENAI_MODEL = "gpt-4-turbo";

// combien de tokens gratuits offerts à un nouveau compte
const START_TOKENS = 5000;

// ============================
// MÉMOIRE EN RAM
// ============================
//
// users[userId] = {
//   tokens: number,
//   history: [ {role:"user"|"assistant"|"system", content:"..."} ]
// }
//
// Note important: ça saute si Render redémarre.
// Pour le moment c’est ok pour test.
const users = {};

// assure qu'un user existe dans la mémoire
function ensureUser(userId) {
  if (!users[userId]) {
    users[userId] = {
      tokens: START_TOKENS,
      history: [
        {
          role: "system",
          content:
            "Tu es Philomène I.A., une assistante personnelle chaleureuse, claire et directe. " +
            "Tu réponds en français par défaut sauf si l'utilisateur parle clairement une autre langue. " +
            "Tu aides pour tout: devoirs, cuisine, pannes techniques (même avec photo), messages à écrire, administratif, etc. " +
            "Tu donnes des réponses utiles, pas trop longues, étape par étape si besoin. " +
            "Tu restes polie et rassurante mais tu ne mens pas. " +
            "Pour l'actualité très récente: si tu n'es pas sûre, tu le dis franchement."
        },
        {
          role: "assistant",
          content:
            "Bonjour 👋 Je suis Philomène I.A.\n" +
            "Tu as un problème, j’ai une solution.\n" +
            "Tu as une question, j’ai une réponse.\n" +
            "Ensemble on ira plus loin 🕊"
        }
      ]
    };
  }
  return users[userId];
}

// calcule à peu près les tokens utilisés pour une réponse
// Ici on prend une estimation simple:
//   prompt_length + answer_length ≈ tokens
// C’est pas exact, mais assez bien pour baisser le compteur.
function estimateTokensUsed(promptText, answerText) {
  const promptWords = promptText ? promptText.split(/\s+/).length : 0;
  const answerWords = answerText ? answerText.split(/\s+/).length : 0;
  // on convertit "mots" vers "tokens" (~0.75 ratio en vrai)
  const approx = Math.round((promptWords + answerWords) * 1.3);
  return approx;
}

// ============================
// APP EXPRESS
// ============================
const app = express();

// CORS ouvert pour ton frontend Render
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ============================
// ROUTE 1: infos utilisateur
// ============================
// frontend va appeler /me au chargement
// en envoyant userId (l'id Clerk)
// On renvoie: tokens restants + historique (pour afficher la discussion)
app.post("/me", (req, res) => {
  const { userId } = req.body || {};

  if (!userId) {
    // pas connecté → on renvoie un profil invité temporaire
    return res.json({
      guest: true,
      tokens: START_TOKENS, // affichage visuel, mais pas stocké
      history: [
        {
          role: "assistant",
          content:
            "Bonjour 👋 Je suis Philomène I.A.\n" +
            "Tu as un problème, j’ai une solution.\n" +
            "Tu as une question, j’ai une réponse.\n" +
            "Ensemble on ira plus loin 🕊"
        }
      ]
    });
  }

  // user connecté
  const u = ensureUser(userId);

  return res.json({
    guest: false,
    tokens: u.tokens,
    history: u.history.filter(m => m.role !== "system") // on cache le system prompt
  });
});

// ============================
// ROUTE 2: poser une question
// ============================
// le front envoie: { userId, text }
// on renvoie: { answer, tokens }
app.post("/ask", async (req, res) => {
  try {
    const { userId, text } = req.body || {};

    if (!text || text.trim() === "") {
      return res.status(400).json({ error: "Message vide." });
    }

    // si pas de compte → on utilise "guest"
    // guest ne sauvegarde pas l'historique sur plusieurs sessions
    const isGuest = !userId;
    const memoryUserId = isGuest ? "_guest_" : userId;

    const u = ensureUser(memoryUserId);

    // si plus de tokens
    if (u.tokens <= 0) {
      return res.status(402).json({
        error: "Plus assez de tokens.",
        tokens: u.tokens
      });
    }

    // on ajoute le message user dans l'historique
    u.history.push({
      role: "user",
      content: text
    });

    // on limite l'historique pour éviter qu'il explose
    // on garde max ~20 derniers échanges (hors system)
    const systemPart = u.history.filter(m => m.role === "system");
    const convoPart = u.history.filter(m => m.role !== "system");
    if (convoPart.length > 40) {
      // on coupe le début
      u.history = [
        ...systemPart,
        ...convoPart.slice(convoPart.length - 40)
      ];
    }

    // on prépare les messages pour OpenAI
    const messagesForOpenAI = u.history.map(m => ({
      role: m.role,
      content: m.content
    }));

    // appel OpenAI
    let answerText = "Désolée, je n’ai pas pu répondre.";
    if (!OPENAI_API_KEY) {
      // mode test sans clé (sécurité)
      answerText =
        "Mode test: ajoute la clé OPENAI_API_KEY dans Render pour activer l'IA.";
    } else {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.6,
          messages: messagesForOpenAI
        })
      });

      const data = await r.json();
      if (r.ok && data && data.choices && data.choices[0]) {
        answerText = data.choices[0].message.content.trim();
      } else {
        console.log("OpenAI error:", data);
        answerText =
          "Je n’ai pas réussi à contacter l’intelligence. Réessaie dans un instant.";
      }
    }

    // on ajoute la réponse de l'assistante dans l'historique
    u.history.push({
      role: "assistant",
      content: answerText
    });

    // on "facture" des tokens
    const usedTokens = estimateTokensUsed(text, answerText);
    u.tokens = Math.max(0, u.tokens - usedTokens);

    return res.json({
      answer: answerText,
      tokens: u.tokens
    });
  } catch (err) {
    console.error("Erreur /ask:", err);
    return res.status(500).json({
      error: "Erreur serveur interne."
    });
  }
});

// ============================
// ROUTE 3: logout (optionnel)
// ============================
// le front pourra juste oublier l'userId côté navigateur,
// mais je te donne quand même un endpoint
app.post("/logout", (req, res) => {
  const { userId } = req.body || {};
  // on ne supprime pas les données pour l'instant
  // comme ça la mémoire reste
  return res.json({ ok: true });
});

// ============================
app.listen(PORT, () => {
  console.log("✅ Philomène backend actif sur le port " + PORT);
});
