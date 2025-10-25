// server.js — CommonJS, prêt pour Render

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const OpenAI = require("openai");

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;

// Domaines autorisés (ajoute/supprime si besoin)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://philomenia.com",
  "https://www.philomenia.com",
  "https://philomeneia.com",
  "https://www.philomeneia.com"
];

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SERPER (actualités)
const SERPER_KEY = process.env.SERPER_API_KEY;

// PayPal
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase(); // "sandbox" | "live"
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PP_BASE =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// ====== APP ======
const app = express();
app.use(express.json({ limit: "10mb" }));

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // ou cb(new Error("Origin not allowed"));
    },
    credentials: true
  })
);

// ====== QUOTAS / TOKENS ======
// Free: 1 000 tokens, Payant: illimité selon achats.
// Compteur très simple en mémoire par client-id.
const STORE = {
  // clientId: { freeRemaining: number, paidBalance: number }
};

function ensureClient(clientId) {
  if (!STORE[clientId]) {
    STORE[clientId] = { freeRemaining:  1000, paidBalance: 0 };
  }
  return STORE[clientId];
}

// estimation approx. des tokens (≈ 4 chars = 1 token)
function approxTokens(str) {
  if (!str) return 0;
  return Math.max(1, Math.ceil(String(str).length / 4));
}

// ====== HEALTH ======
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ====== QUOTA ======
app.get("/api/quota", (req, res) => {
  const clientId = req.headers["x-client-id"] || "anon";
  const c = ensureClient(clientId);
  res.json({
    clientId,
    freeRemaining: c.freeRemaining,
    paidBalance: c.paidBalance,
    totalRemaining: c.freeRemaining + c.paidBalance
  });
});

// ====== NEWS (SERPER) ======
app.get("/api/news", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Paramètre q requis" });
    if (!SERPER_KEY) return res.status(500).json({ error: "SERPER_API_KEY manquante" });

    const r = await fetch("https://google.serper.dev/news", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q })
    });

    const j = await r.json();
    const items = (j.news || []).slice(0, 5).map((n) => ({
      title: n.title,
      url: n.link,
      source: n.source,
      date: n.date
    }));
    res.json({ results: items });
  } catch (err) {
    console.error("News error:", err);
    res.status(500).json({ error: "Erreur actualités" });
  }
});

// ====== CHAT ======
app.post("/api/chat", async (req, res) => {
  try {
    const clientId = req.headers["x-client-id"] || "anon";
    const lang = (req.headers["x-lang"] || "fr").toString().toLowerCase();
    const model =
      (req.headers["x-model"] || "").trim() ||
      "gpt-4o-mini"; // modèle par défaut (économique)

    const { message, image } = req.body || {};
    const text = (message || "").toString().trim();

    if (!text && !image) {
      return res.status(400).json({ error: "message ou image requis" });
    }

    // Vérifie/consomme tokens
    const c = ensureClient(clientId);
    const estimated = approxTokens(text) + (image ? 200 : 0); // image ~ gros coût arbitraire
    let remaining = c.freeRemaining + c.paidBalance;
    if (remaining <= 0) {
      return res.status(402).json({
        error: "Plus de tokens. Recharge via PayPal.",
        quota: {
          freeRemaining: c.freeRemaining,
          paidBalance: c.paidBalance,
          totalRemaining: remaining
        }
      });
    }
    // Consomme d'abord le gratuit
    let toConsume = estimated;
    let consumeFree = Math.min(c.freeRemaining, toConsume);
    c.freeRemaining -= consumeFree;
    toConsume -= consumeFree;
    if (toConsume > 0) {
      c.paidBalance = Math.max(0, c.paidBalance - toConsume);
    }

    const systemPrompt =
      lang === "fr"
        ? "Tu es Philomène, utile, claire et concise. Réponds en français naturel."
        : lang === "nl"
        ? "Je bent Philomène, behulpzaam en duidelijk. Antwoord in natuurlijk Nederlands."
        : "You are Philomène, helpful and clear. Answer in natural English.";

    const msgs = [{ role: "system", content: systemPrompt }];

    if (image && image.startsWith("data:image/")) {
      msgs.push({
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: image } }
        ]
      });
    } else {
      msgs.push({ role: "user", content: text });
    }

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.5,
      max_tokens: 600, // sécurité
      messages: msgs
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() || "(pas de réponse)";

    // Mise à jour du compteur selon la réponse (sortie)
    const outTokens = approxTokens(reply);
    let moreToConsume = outTokens;
    if (c.freeRemaining > 0) {
      const f = Math.min(c.freeRemaining, moreToConsume);
      c.freeRemaining -= f;
      moreToConsume -= f;
    }
    if (moreToConsume > 0) {
      c.paidBalance = Math.max(0, c.paidBalance - moreToConsume);
    }

    res.json({
      reply,
      quota: {
        freeRemaining: c.freeRemaining,
        paidBalance: c.paidBalance,
        totalRemaining: c.freeRemaining + c.paidBalance
      }
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Erreur serveur (chat)" });
  }
});

// === PayPal (token + create order) ===
const PP_BASE = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function paypalAccessToken() {
  const creds = Buffer
    .from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`)
    .toString("base64");

  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const j = await r.json();
  if (!r.ok) {
    console.error("paypal token error", j);
    throw new Error(j.error_description || j.error || "paypal token error");
  }
  return j.access_token;
}

// Route de debug pour vérifier le token PayPal
app.get("/api/paypal/debug", async (_req, res) => {
  try {
    const t = await paypalAccessToken();
    res.json({
      ok: true,
      mode: process.env.PAYPAL_MODE,
      tokenPreview: t.slice(0, 12) + "…"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Création d'une commande (redirigé vers PayPal ensuite)
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    if (process.env.PAYMENT_ENABLED !== "true") {
      return res.status(503).json({ error: "Payments are disabled" });
    }

    const { price, tokens } = req.body;
    if (!price || !tokens) {
      return res.status(400).json({ error: "Missing price or tokens" });
    }

    const access = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: { currency_code: "EUR", value: Number(price).toFixed(2) },
          custom_id: String(tokens)
        }],
        application_context: {
          user_action: "PAY_NOW" // (facultatif) bouton Pay Now
        }
      })
    });

    const j = await r.json();
    if (!r.ok) {
      console.error("create order error", j);
      return res.status(500).json({ error: "PP create order", details: j });
    }

    const approveUrl = j.links?.find(l => l.rel === "approve")?.href;
    return res.json({ id: j.id, approveUrl });
  } catch (e) {
    console.error("create order catch", e);
    res.status(500).json({ error: String(e) });
  }
});

// Capturer une commande et créditer les tokens
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId requis" });

    const access = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json"
      }
    });
    const j = await r.json();

    const unit = j.purchase_units?.[0];
    let credited = 0;
    if (unit?.payments?.captures?.[0]?.status === "COMPLETED") {
      // On récupère ce qu'on a encodé dans custom_id (clientId + tokens)
      let meta = {};
      try {
        meta = JSON.parse(unit.custom_id || "{}");
      } catch (_) {}
      const clientId = meta.clientId || "anon";
      const tokens = parseInt(meta.tokens || 0, 10) || 0;
      const c = ensureClient(clientId);
      c.paidBalance += tokens;
      credited = tokens;
      return res.json({
        ok: true,
        credited,
        quota: {
          freeRemaining: c.freeRemaining,
          paidBalance: c.paidBalance,
          totalRemaining: c.freeRemaining + c.paidBalance
        }
      });
    } else {
      return res.status(400).json({ error: "Capture non complétée", data: j });
    }
  } catch (err) {
    console.error("PP capture error:", err);
    res.status(500).json({ error: "Erreur PayPal (capture)" });
  }
});

// ====== START ======
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
