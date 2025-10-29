import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const {
  OPENAI_API_KEY,
  ALLOW_ORIGINS = "",
  PORT = 10000,
  FREE_AFTER_SIGNUP = "5000",
  FREE_ANON = "1000",
} = process.env;

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS dynamique
const allowedOrigins = ALLOW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      console.log("❌ CORS blocked:", origin);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Helpers
const ok = (res, data) => res.json(data);
const fail = (res, e, code = 500) => {
  console.error(e?.stack || e);
  res.status(code).json({ error: e?.message || "Server error" });
};

// —————————————————— Mini “browsing” très simple ——————————————————
// On utilise un fetch en lecture publique (r.jina.ai) pour récupérer un texte récent
// et on l’injecte comme "contexte web" au modèle.
async function webContextFrom(url) {
  const u = `https://r.jina.ai/http://` + url.replace(/^https?:\/\//, "");
  const r = await fetch(u, { timeout: 10_000 });
  if (!r.ok) throw new Error(`Web fetch failed: ${r.status}`);
  return await r.text();
}

async function smartNewsContext(userMsg) {
  // Quelques URLs génériques utiles quand on pose des questions d’actualité FR
  // Tu peux élargir la liste si tu veux
  const candidates = [
    "en.wikipedia.org/wiki/Prime_Minister_of_France",
    "en.wikipedia.org/wiki/Government_of_France",
    "news.google.com/rss/search?q=site:gov.fr",
  ];

  // Si on détecte des mots-clés, on priorise une page
  const m = userMsg.toLowerCase();
  if (m.includes("premier ministre") || m.includes("première ministre")) {
    candidates.unshift("en.wikipedia.org/wiki/Prime_Minister_of_France");
  }

  // On essaie 1 ou 2 sources max pour rester léger
  const take = candidates.slice(0, 2);
  const texts = [];
  for (const url of take) {
    try {
      const t = await webContextFrom(url);
      texts.push(`SOURCE: ${url}\n${t.slice(0, 12000)}`); // limite pour ne pas exploser le contexte
    } catch (e) {
      console.warn("web fetch fail:", url, e.message);
    }
  }
  if (!texts.length) return null;
  return texts.join("\n\n––––––––––––––––––––––––––––––––\n\n");
}

// —————————————————— Routes ——————————————————

app.get("/", (req, res) => res.send("✅ Philomenia API en ligne"));

app.get("/api/balance", (req, res) => {
  // maquette simple (à connecter à ta DB plus tard)
  ok(res, { free: Number(FREE_AFTER_SIGNUP), paid: 0 });
});

// Chat texte, avec “actu” auto si on détecte une question potentiellement fraîche
app.post("/api/chat", async (req, res) => {
  try {
    const { message, email, force_browse = false } = req.body || {};
    if (!message || typeof message !== "string") {
      return fail(res, new Error("Paramètre 'message' manquant"), 400);
    }

    // Détecter si le user demande de l’actu
    const msg = message.trim();
    const askFresh =
      force_browse ||
      /\b(aujourd'hui|actuel|actuellement|en ce moment|202\d|202[45]|qui est|derni(ères|er)|news|actualité)\b/i.test(
        msg
      );

    let webContext = null;
    if (askFresh) {
      try {
        webContext = await smartNewsContext(msg);
      } catch (e) {
        console.warn("news context failed:", e.message);
      }
    }

    const system = [
      {
        role: "system",
        content:
          "Tu es Philomène, assistante personnelle. Donne des réponses utiles, claires et fiables." +
          " Date actuelle: " +
          new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) +
          ". Si la question semble liée à l'actualité, utilise le contexte web fourni si présent. " +
          "Quand tu n'es pas certain, annonce l'incertitude plutôt que d'inventer. " +
          "Écris en français par défaut. Reste concise.",
      },
    ];

    const userParts = [{ type: "text", text: msg }];

    const messages = [
      ...system,
      ...(webContext
        ? [
            {
              role: "system",
              content:
                "CONTEXTE_WEB (résumé brut non vérifié, ne cite pas textuellement si tu n'es pas sûr):\n" +
                webContext,
            },
          ]
        : []),
      { role: "user", content: userParts },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3,
    });

    const reply = resp.choices?.[0]?.message?.content?.toString().trim() || "Réponse reçue.";
    ok(res, { reply });
  } catch (e) {
    fail(res, e);
  }
});

// Analyse d’image (A+B+C+D+E): /api/photo (multipart form-data: field "photo")
app.post("/api/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return fail(res, new Error("Aucun fichier reçu (champ 'photo')"), 400);

    const mime = req.file.mimetype || "image/jpeg";
    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${mime};base64,${base64}`;

    const instruction =
      (req.body?.instruction ||
        "Analyse cette image. 1) Décris la scène/objets. 2) Si c'est une panne/erreur, donne un diagnostic." +
          " 3) Si du texte est présent, fais l'OCR. 4) Termine par des conseils actionnables.") + "";

    const messages = [
      {
        role: "system",
        content:
          "Tu es Philomène vision. Donne une analyse fiable, précise et pratique. Structure en points courts.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const reply = resp.choices?.[0]?.message?.content?.toString().trim() || "Analyse terminée.";
    ok(res, { reply });
  } catch (e) {
    fail(res, e);
  }
});

// —————————————————— Lancement ——————————————————
app.listen(PORT, () => {
  console.log(`✅ Philomenia API running on port ${PORT}`);
});
