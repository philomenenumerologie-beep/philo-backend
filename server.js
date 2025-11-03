import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

// Autoriser ton front à appeler l'API
app.use(cors({
  origin: [
    "https://philomeneia.com",
    "https://www.philomeneia.com"
  ],
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// IMPORTANT : mets ta clé OpenAI dans la variable d'environnement OPENAI_API_KEY sur Render
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// =======================
// CHOIX DU MODÈLE
// =======================
//
// Ici tu peux mettre le modèle "premium" que tu veux vendre comme GPT-5.
// Pour l’instant je laisse ton modèle actuel pour pas tout casser.
// Quand tu passeras à un modèle plus cher (genre GPT-4o / GPT-4.1 / "GPT-5"),
// tu changes juste cette constante.
const OPENAI_MODEL = "gpt-4o-mini";


// =======================
// ROUTE /ask
// =======================
//
// Le front envoie :
// {
//   conversation: [{role:"user"|"assistant", content:"..."}],
//   userId: "...",
//   tokens: 12345   // solde actuel vu par le front
// }
//
// Nous :
// 1. On envoie la conversation à OpenAI
// 2. On récupère la réponse + l'usage tokens
// 3. On calcule le coût consommé pour CETTE réponse
//    -> on ne facture QUE la réponse IA, pas la question de l'utilisateur
// 4. On renvoie au front :
//    answer, used_tokens, new_balance
//
app.post("/ask", async (req, res) => {
  try {
    const { conversation, tokens } = req.body;

    if (!conversation || !Array.isArray(conversation)) {
      return res.status(400).json({ error: "conversation manquante ou invalide" });
    }

    // solde "vu par le front"
    const previousBalance = (typeof tokens === "number" && tokens >= 0)
      ? tokens
      : 0;

    // Appel à OpenAI
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

    // Sécurité : vérifier le retour OpenAI
    if (!data || !data.choices || !data.choices[0]) {
      console.error("Réponse OpenAI inattendue:", data);
      return res.status(500).json({ error: "Réponse invalide d'OpenAI." });
    }

    // Texte final envoyé à l'utilisateur
    const answer = data.choices[0].message?.content || "";

    // ---- TOKEN USAGE ----
    //
    // OpenAI renvoie normalement data.usage = {
    //   prompt_tokens: ...,
    //   completion_tokens: ...,
    //   total_tokens: ...
    // }
    //
    // On veut facturer SEULEMENT la sortie IA (= completion_tokens)
    // pour éviter de défoncer le solde juste parce que l'historique est long.
    //
    // Pourquoi ?
    // - Ça évite le "-700 tokens" dès le premier message.
    // - C'est plus simple à expliquer au client :
    //   "Tu paies uniquement ce que je t'écris."
    //
    const usage = data.usage || {};

    // On récupère les tokens de réponse IA
    const completionTokens =
      (usage.completion_tokens ?? usage.completionTokens ?? 0);

    // Sécurité : on force au moins 1 token
    const consumedTokens = Math.max(1, completionTokens);

    // Nouveau solde
    let newBalance = previousBalance - consumedTokens;
    if (newBalance < 0) newBalance = 0;

    // On renvoie au front
    return res.json({
      answer,
      used_tokens: consumedTokens,
      new_balance: newBalance,
      usage // pour debug côté front si tu veux voir les vrais chiffres
    });

  } catch (err) {
    console.error("Erreur /ask:", err);
    return res.status(500).json({ error: "Erreur serveur interne." });
  }
});


// Petite route GET / pour tester vite fait si le serveur tourne
app.get("/", (_req, res) => {
  res.send("✅ API Philomène I.A. en ligne.");
});


// Lancement du serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Philomène API en ligne sur le port " + PORT);
});
