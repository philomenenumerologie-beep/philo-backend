/* =========================================
   Philomène IA – Backend (Express + Clerk)
   ========================================= */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { Webhook } from "svix";           // vérification Clerk webhooks

// ===== App
const app = express();
app.use(express.json());

// ===== CORS (modifie si besoin)
const allowedOrigins = JSON.parse(process.env.ALLOWED_ORIGINS || '["https://philomeneia.com"]');
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// ====== Mini “base de données” en mémoire (OK pour démarrer)
const users = new Map(); // key = clerkUserId, value = { free: number, paid: number }

// ===== Page ping
app.get("/", (_req, res) => res.send("API Philomène IA • OK"));

// ===== Balance pour l'utilisateur courant
// Front te passera l'ID Clerk via Authorization: Bearer <token JWT signé côté serveur>,
// mais pour faire simple on accepte ?uid=<clerkUserId> pendant la mise en place.
app.get("/api/balance", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: "uid manquant" });

  const row = users.get(uid) || { free: 0, paid: 0 };
  res.json({
    free: Number(row.free || 0),
    paid: Number(row.paid || 0),
    total: Number((row.free || 0) + (row.paid || 0)),
  });
});

// ===== Consommer des tokens (exemple pour /api/chat)
app.post("/api/chat", async (req, res) => {
  const { uid, message } = req.body || {};
  if (!uid || !message) return res.status(400).json({ error: "uid et message requis" });

  const row = users.get(uid) || { free: 0, paid: 0 };
  const available = (row.free || 0) + (row.paid || 0);
  if (available <= 0) return res.status(402).json({ error: "Plus de tokens" });

  // Décompte 1 token par message (à ajuster selon ton modèle/coût)
  if (row.free > 0) row.free -= 1;
  else row.paid -= 1;
  users.set(uid, row);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: message }],
      }),
    });
    const data = await r.json();
    res.json({ reply: data?.choices?.[0]?.message?.content || "(pas de réponse)" });
  } catch (err) {
    res.status(500).json({ error: "Erreur OpenAI" });
  }
});

// ===== Webhook Clerk : donne 5000 tokens à la création d'utilisateur
app.post("/webhooks/clerk", async (req, res) => {
  const whSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!whSecret) return res.status(500).send("CLERK_WEBHOOK_SECRET manquant");

  const svix_id = req.headers["svix-id"];
  const svix_timestamp = req.headers["svix-timestamp"];
  const svix_signature = req.headers["svix-signature"];
  if (!svix_id || !svix_timestamp || !svix_signature) {
    return res.status(400).send("Headers Svix manquants");
  }

  const payload = req.body;
  const body = JSON.stringify(payload);

  try {
    const wh = new Webhook(whSecret);
    const evt = wh.verify(body, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    });

    // On s'intéresse à user.created
    if (evt.type === "user.created") {
      const uid = evt.data.id; // Clerk user id
      const startCredits = Number(process.env.FREE_ANON_CREDITS || 5000);

      // Si déjà présent, ne pas redonner
      const current = users.get(uid);
      if (!current) {
        users.set(uid, { free: startCredits, paid: 0 });
        console.log("🎁 Crédit de bienvenue attribué:", uid, startCredits);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("⚠️ Webhook verify error:", err);
    res.status(400).send("Signature invalide");
  }
});

// ===== Lancement serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Backend Philomène IA sur", PORT));
