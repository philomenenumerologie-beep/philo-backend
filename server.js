// server.js — Philomene GPT (actualités via Serper)
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🧠 Ton ton système / style de réponse
const SYSTEM_PROMPT = `
Tu es "Philomene GPT", un assistant français, clair et concret.
Règles :
- Réponds en français, simplement, avec des étapes si utile.
- Donne des exemples concrets.
- Pas d'affirmations non étayées.
- Si on te demande un résumé actionnable, fournis des puces courtes.
`;

// --------- Aide images (si jamais ton front envoie des dataURL) ----------
function dataUrlToImageContent(dataUrl) {
  if (!dataUrl) return null;
  return { type: "image_url", image_url: { url: dataUrl } };
}
// ------------------------------------------------------------------------

// 🔎 Détection simple : est-ce probablement une question d’actualité ?
function shouldSearchNews(text = "") {
  const t = (text || "").toLowerCase();

  // mots/expressions fréquents pour l'actu récente
  const triggers = [
    "aujourd'hui", "hier", "en ce moment", "dernières", "dernier", "récents",
    "actualité", "actu", "news", "breaking", "qui a gagné", "résultat",
    "score", "match", "ligue des champions", "élection", "guerre",
    "inflation", "taux", "bourse", "mort de", "condamné",
    "procès", "décision de justice", "nommé", "démission",
    "2024", "2025" // années récentes
  ];
  if (triggers.some(w => t.includes(w))) return true;

  // s'il y a explicitement "source", "lien", etc.
  if (/\b(source|lien|article|presse|journal)\b/.test(t)) return true;

  // date explicite JJ/MM ou mois lettres + année
  if (/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t)) return true;
  if (/\b(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc)\w* 20(24|25)\b/i.test(t)) return true;

  return false;
}

// 📰 Appel Serper (Google News via serper.dev)
async function searchNewsWithSerper(query) {
  const API = "https://google.serper.dev/news";
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.SERPER_API_KEY, // serper.dev accepte aussi "X-API-KEY"
      "Authorization": `Bearer ${process.env.SERPER_API_KEY}` // et "Authorization: Bearer"
    },
    body: JSON.stringify({
      q: query,
      gl: "fr",  // pays
      hl: "fr"   // langue
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Serper error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  // data.news est souvent le tableau principal ; sinon, fallback sur data.organic
  const items = Array.isArray(data.news) ? data.news : (data.organic || []);
  return items.slice(0, 5); // Top 5 sources
}

// 🧾 Mise en forme du contexte actu pour l'IA
function buildNewsContext(items = []) {
  if (!items.length) return "Aucune source trouvée.";
  return items.map((it, i) => {
    const title = it.title || it.titleRaw || "Sans titre";
    const date = it.date || it.dateUtc || it.datePublished || "";
    const source = it.source || it.sourceUrl || "";
    const link = it.link || it.url || "";
    const snippet = it.snippet || it.text || "";
    return `#${i + 1}. ${title}
- Date: ${date}
- Source: ${source}
- Lien: ${link}
- Extrait: ${snippet}`;
  }).join("\n\n");
}

app.get("/", (_req, res) => res.json({ ok: true }));

app.post("/api/chat", async (req, res) => {
  try {
    const { plan = "mini", messages = [] } = req.body || {};
    const model = plan === "pro" ? "gpt-4.1-mini" : "gpt-4o-mini";

    // récupère le dernier message utilisateur
    const lastUser = [...messages].reverse().find(m => m.role === "user") || {};
    const userText = lastUser?.content || "";

    // Transforme l'historique pour OpenAI (texte + éventuelle image)
    const oaMessages = [{ role: "system", content: SYSTEM_PROMPT }];

    for (const m of messages) {
      if (m.role === "system") continue; // on garde notre system à nous
      const parts = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      if (m.imageDataUrl) {
        const img = dataUrlToImageContent(m.imageDataUrl);
        if (img) parts.push(img);
      }
      oaMessages.push({ role: m.role, content: parts.length ? parts : [{ type: "text", text: "" }] });
    }

    let usedNews = false;

    if (shouldSearchNews(userText)) {
      try {
        const news = await searchNewsWithSerper(userText);
        const newsContext = buildNewsContext(news);

        // On donne un contexte "actualité" séparé pour contraindre l’IA à s’appuyer dessus
        oaMessages.push({
          role: "system",
          content:
`Contexte d'actualité (sources externes, résumé ci-dessous).
Utilise UNIQUEMENT ces sources pour les faits récents. Si c'est insuffisant, dis-le.
Inclue en fin de réponse une section "Sources" avec des puces (titre — domaine).`
        });
        oaMessages.push({ role: "system", content: newsContext });

        usedNews = true;
      } catch (e) {
        // Si Serper échoue, on continue sans actu
        console.error("Serper/news error:", e.message);
      }
    }

    const completion = await client.chat.completions.create({
      model,
      messages: oaMessages,
      temperature: 0.4
    });

    let answer = completion.choices?.[0]?.message?.content?.trim() || "Désolé, je n’ai pas de réponse.";

    // Petit rappel visuel si actu utilisée mais pas de section Sources détectée
    if (usedNews && !/sources\s*:/i.test(answer)) {
      answer += `\n\n_Sources : disponibles ci-dessus dans le contexte._`;
    }

    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur", details: err.message });
  }
});

// Port Render/Heroku style
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Philomene backend prêt sur :${PORT}`);
});
