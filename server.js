import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

// Autoriser le front à appeler l'API
app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ta clé doit être configurée en variable d'environnement OPENAI_API_KEY dans Render
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";

// route qui répond aux messages
app.post("/ask", async (req, res) => {
  try {
    const { conversation } = req.body; // tableau [{role, content}, ...]

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

    const answer = data.choices[0].message.content;
    res.json({ answer });
  } catch (err) {
    console.error("Erreur /ask:", err);
    res.status(500).json({ error: "Erreur serveur interne." });
  }
});

// test GET /
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne.");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Philomène API en ligne sur le port " + PORT);
});
