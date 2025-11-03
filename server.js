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

// === Choisis ici le modèle que tu veux vendre comme "GPT-5" ===
// Tu pourras mettre le vrai nom du modèle OpenAI haut de gamme que tu utilises.
// Pour l'instant je laisse gpt-4o-mini dans le code d'origine pour pas tout casser,
// mais idéalement tu le remplaceras par le modèle premium (ex: "gpt-4o" / "gpt-4.1", etc.)
const OPENAI_MODEL = "gpt-4o-mini";


// ========== PETIT HELPER ==========
// calcule le coût en "tokens Philomène" basé sur les tokens réels OpenAI
// Ici, on fait simple : 1 token OpenAI = 1 token Philomène
// Si tu veux facturer plus cher la sortie plus tard, tu peux changer ici.
function computeConsumedTokens(usage) {
  if (!usage) return 0;

  const promptTokens = usage.prompt_tokens ?? usage.promptTokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  // tu peux mettre une logique différente si tu veux :
  // ex: ne compter que completionTokens, ou multiplier completionTokens par 2, etc.
  return totalTokens;
}


// ========== ROUTE /ask ==========
// Reçoit { conversation, userId, tokens }
// conversation = tableau [{role:"user"|"assistant", content:"..."}]
// tokens = solde actuel coté front (ex: 200000, 199521, etc.)
app.post("/ask", async (req, res) => {
  try {
    const { conversation, tokens } = req.body;

    if (!conversation || !Array.isArray(conversation)) {
      return res.status(400).json({ error: "conversation manquante ou invalide" });
    }

    // Sécurité: si pas de solde envoyé, on considère 0
    const previousBalance = typeof tokens === "number" ? tokens : 0;

    // Appel OpenAI
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

    // check basique
    if (!data || !data.choices || !data.choices[0]) {
      console.error("Réponse OpenAI inattendue:", data);
      return res.status(500).json({ error: "Réponse invalide d'OpenAI." });
    }

    // Texte de la réponse
    const answer = data.choices[0].message.content || "";

    // Usage / tokens réels OpenAI
    // OpenAI renvoie normalement un bloc "usage" avec prompt_tokens, completion_tokens, total_tokens
    const usage = data.usage || {};
    const consumedTokens = computeConsumedTokens(usage); // combien on décompte

    // Nouveau solde
    // IMPORTANT :
    // Ici on enlève les tokens réels utilisés à chaque échange.
    // Si le solde tombe en négatif, on le bloque à 0.
    let newBalance = previousBalance - consumedTokens;
    if (newBalance < 0) newBalance = 0;

    // Renvoi au front
    return res.json({
      answer,
      used_tokens: consumedTokens,
      new_balance: newBalance,
      usage // tu peux le logger pour debug côté front
    });

  } catch (err) {
    console.error("Erreur /ask:", err);
    return res.status(500).json({ error: "Erreur serveur interne." });
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
