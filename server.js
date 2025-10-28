/* ===============================
   Philomenia – Backend complet
   =============================== */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { Webhook } from "svix"; // vérification Clerk Webhooks

// ---------- Utils de chemin
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App
const app = express();

// ---------- CORS sécurisé
const allowedOrigins = (() => {
  try {
    return JSON.parse(process.env.ALLOWED_ORIGINS || "[]");
  } catch {
    return [];
  }
})();
app.use(
  cors({
    origin: (origin, cb) => {
      // autorise requêtes server-to-server / local sans origin
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  })
);

// Le JSON parser global (⚠️ le webhook aura son propre parser raw)
app.use(express.json());

// ---------- Resend (optionnel)
const resend = new Resend(process.env.RESEND_API_KEY);

// =====================
// Routes de test / util
// =====================

app.get("/", (_req, res) => {
  res.send("API Philomenia OK");
});

app.get("/balance", (_req, res) => {
  res.json({
    free: Number(process.env.FREE_ANON_CREDITS || 5000),
    paid: Number(process.env.PAID_CREDITS || 0),
  });
});

// ===================================
// Webhook Clerk : créditer 5000 tokens
// ===================================
// Important : route AVANT app.listen ; parser RAW uniquement pour CE endpoint
app.post(
  "/webhooks/clerk",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const signingSecret = process.env.CLERK_WEBHOOK_SECRET;
      if (!signingSecret) {
        console.error("❌ CLERK_WEBHOOK_SECRET manquant");
        return res.status(500).send("Server misconfigured");
      }

      // Vérifie la signature Svix (format Clerk)
      const wh = new Webhook(signingSecret);

      // req.body est un Buffer à cause de express.raw
      const evt = wh.verify(req.body, req.headers);

      const { type, data } = evt;

      // On réagit créa d’utilisateur
      if (type === "user.created") {
        const userId = data?.id;
        const email =
          data?.email_addresses?.[0]?.email_address ??
          data?.primary_email_address_id ??
          "unknown";

        // TODO: ici, mets à jour ta base (ou KV, ou Supabase) :
        // addCredits(userId, 5000)

        console.log("🎉 user.created", { userId, email });
        console.log("🎁 5000 tokens ajoutés (à implémenter côté stockage)");
      }

      res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Erreur webhook Clerk:", err?.message || err);
      res.status(400).send("Bad webhook");
    }
  }
);

// ===================================
// Chat OpenAI – simple proxy backend
// ===================================
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "Message manquant" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY manquant" });

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Tu es l’assistant de Philomenia." },
          { role: "user", content: message },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI error:", text);
      return res.status(500).json({ error: "OpenAI request failed" });
    }

    const data = await response.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim?.() ||
      "(pas de réponse)";

    res.json({ reply });
  } catch (err) {
    console.error("❌ /api/chat error:", err?.message || err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===================================
// Lancement
// ===================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend Philomenia prêt sur port ${PORT}`);
});
