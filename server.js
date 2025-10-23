// server.js — backend complet (Express + OpenAI + Serper News)
// Type ESM (cf. "type": "module" dans package.json)

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ---- Config de base
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---- Clients & clés
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SERPER_API_KEY = process.env.SERPER_API_KEY; // définie sur Render

// ---- Prompt système (personnalité)
const SYSTEM_PROMPT = `
Tu es "Philomene GPT", un assistant français clair et bienveillant.
Règles :
- Réponds en français, simplement, avec des exemples si utile.
- Si tu utilises des sources web, cite-les brièvement en fin de message (domaines + titres courts).
- Ne donne pas d'affirmations non étayées pour l'actualité ; si incertain, dis-le et propose de vérifier.
- Réponses concises par défaut, mais complètes si on te le demande.
`;

// ---------- Utilitaires images (si le front t’envoie une image en dataURL)
function dataUrlToImageContent(dataUrl) {
  if (!dataUrl) return null;
  return { type: "image_url", image_url: { url: dataUrl } };
}

// ---------- Détection "actualité"
function looksLikeNewsQuery(text = "") {
  if (!text) return false;
  const t = text.toLowerCase();
  const newsWords = [
    "actualité", "actu", "aujourd'hui", "dernières nouvelles",
    "breaking", "ce matin", "ce soir", "en direct",
    "qui est le premier ministre", "résultats du match",
    "élections", "guerre", "manifestation", "procès", "condamné",
    "Sarkozy", "Premier ministre", "gouvernement", "football", "Ligue des champions"
  ];
  return newsWords.some(w => t.includes(w));
}

// ---------- Recherche Serper (Google) : web + news
async function serperSearch(q) {
  if (!SERPER_API_KEY) return null;
  // endpoint "news" est souvent plus pertinent pour l'actualité
  const endpoint = "https://serper.dev/api/news";
  const body = {
    q,
    gl: "fr", // géolocalisation France
    hl: "fr"  // langue française
  };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
    const json = await res.json();

    // On normalise quelques champs (titre, snippet, source, lien)
    const items = Array.isArray(json.news) ? json.news : [];
    return items.slice(0, 5).map(n => ({
      title: n.title,
      snippet: n.snippet,
      source: n.source || (n.date ? "news" : "web"),
      link: n.link
    }));
  } catch (err) {
    console.error("Serper error:", err.message);
    return null;
  }
}

// ---------- Construction du message de contexte à partir des news
function buildNewsContext(news = []) {
  if (!news || news.length === 0) return "";
  let ctx = "Voici un résumé des infos trouvées en ligne :\n";
  news.forEach((n, i) => {
    ctx += `- (${i + 1}) ${n.title} — ${n.source}\n  ${n.snippet}\n  Lien: ${n.link}\n`;
  });
  ctx += "\nUtilise ces éléments pour répondre factuellement et cite les sources en fin de réponse (par ex. (source: domaine)).\n";
  return ctx;
}

// ---------- Mapping de l’historique venant du front vers le format OpenAI
function toOpenAIMessages(history = [], system = SYSTEM_PROMPT, newsContext = "") {
  const msgs = [{ role: "system", content: system + (newsContext ? "\n\n" + newsContext : "") }];
  for (const m of history) {
    const content = [];
    if (m.content) content.push({ type: "text", text: m.content });
    if (m.image) {
      const img = dataUrlToImageContent(m.image);
      if (img) content.push(img);
    }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return msgs;
}

// ---------- Route santé
app.get("/", (_req, res) => {
  res.type("text").send("Philomene backend en ligne ✅");
});

// ---------- Route chat
app.post("/api/chat", async (req, res) => {
  try {
    const { plan = "mini", messages = [] } = req.body || {};
    // Le dernier message utilisateur
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content || "";

    // Si demande d'actualités (ou plan explicite), on va chercher des news
    let news = null;
    if (plan === "actu" || looksLikeNewsQuery(lastUserMsg)) {
      news = await serperSearch(lastUserMsg);
    }
    const newsContext = buildNewsContext(news);

    // Construire le chat complet
    const chatMessages = toOpenAIMessages(messages, SYSTEM_PROMPT, newsContext);

    // Appel OpenAI (modèle light et économique, multimodal)
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: chatMessages,
      temperature: 0.4,
      max_tokens: 600,
    });

    let reply = completion.choices?.[0]?.message?.content?.trim() || "(réponse vide)";

    // Si on a des news, ajoute une ligne de sources très courte
    if (news && news.length) {
      const shortSources = news
        .map(n => {
          try {
            const u = new URL(n.link);
            return u.hostname.replace(/^www\./, "");
          } catch (_) {
            return n.source || "source";
          }
        })
        .slice(0, 4);
      reply += `\n\n_(sources : ${[...new Set(shortSources)].join(", ")})_`;
    }

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Oups, une erreur s’est produite côté serveur." });
  }
});

// ---------- Démarrage Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Philomene backend prêt sur :${PORT}`);
});
