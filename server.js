// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

// stockage mémoire basique { userId: [ {role, content}, ... ] }
const conversations = {};

// CORS: autoriser le front officiel
app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type"]
}));

// lire le JSON envoyé par le front
app.use(express.json());

// OpenAI config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = "gpt-4o-mini";

// petite route GET / => ping
app.get("/", (req, res) => {
  res.send("✅ API Philomène IA en ligne.");
});

// Récupérer l'historique pour un user
// GET /history?userId=xxx
app.get("/history", (req, res) => {
  const userId = req.query.userId;
  if (!userId || !conversations[userId]) {
    // pas de conv => renvoyer tableau vide
    return res.json({ messages: [] });
  }
  res.json({ messages: conversations[userId] });
});

// Envoyer un message à l'IA
// body: { userId, conversation: [...] }
app.post("/ask", async (req, res) => {
  try {
    const { userId, conversation } = req.body;

    // conversation attendue:
    // [ {role:"system", content:"..."}, {role:"assistant", content:"..."}, ... ]

    // on forward vers OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: conversation.map(m => ({
          role: m.role,
          content: m.content
        })),
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!data || !data.choices || !data.choices[0]) {
      return res.status(500).json({ error: "Réponse invalide d'OpenAI." });
    }

    const answer = data.choices[0].message.content || "";

    // si on a un userId connecté, on sauvegarde son historique
    if (userId) {
      conversations[userId] = conversation.concat([
        { role: "assistant", content: answer }
      ]);
    }

    res.json({ answer });
  } catch (err) {
    console.error("Erreur /ask:", err);
    res.status(500).json({ error: "Une erreur est survenue côté serveur." });
  }
});

// Render doit savoir sur quel port écouter
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Philomène API en ligne sur le port " + PORT);
});
