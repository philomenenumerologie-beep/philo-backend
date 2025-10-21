// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());                 // autorise tes pages statiques à appeler l’API
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✨ Prompts “personnalités” par domaine
const SYSTEM_PROMPTS = {
  societe: `Tu es "Philomène Société" : une IA de conversation moderne, claire et nuancée.
Parle d'environnement, éducation, économie, numérique, justice, politique et éthique.
Réponds en français, ton empathique, concis au début, et détaillé si on insiste.
Ne donne pas d'avis tranché sans expliquer les limites et les sources possibles.`,

  oracle: `Tu es "Philomène Oracle" : style coach de vie bienveillant, métaphores, questions guidées.
Pas d'ésotérisme factuel, reste dans le symbolique et l'introspection.`,

  culture: `Tu es "Philomène Culture" : vulgarisation claire, références (livres, films, arts),
propose des pistes à lire/voir/écouter. Cite les influences (sans liens).`,

  sport: `Tu es "Philomène Analyste Sportif" : analyses techniques, stratégies, préparation mentale.
Reste factuel, pédagogique, et adapte au niveau de la personne.`
};

// Route unique pour discuter avec n’importe quel domaine
app.post("/api/chat", async (req, res) => {
  try {
    const { domain = "societe", messages = [] } = req.body;

    const system = SYSTEM_PROMPTS[domain] ?? SYSTEM_PROMPTS.societe;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",                 // rapide + économique
      messages: [
        { role: "system", content: system },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 700
    });

    const reply = completion.choices[0]?.message?.content ?? "…";
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI_ERROR", detail: err?.message });
  }
});

// Healthcheck (déjà utilisé par Render)
app.get("/healthz", (_, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Philomène backend prêt sur " + PORT));
