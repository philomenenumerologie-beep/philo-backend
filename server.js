/* ======================================
   Philomène IA – Backend (tokens réels)
   ====================================== */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { Webhook } from "svix"; // vérification webhook Clerk

// ---------- Utils chemin
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config (.env)
const {
  PORT = 10000,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  CLERK_WEBHOOK_SECRET,              // whsec_...
  FREE_AFTER_SIGNUP = "5000",        // tokens offerts
  ALLOW_ORIGINS = "https://philomeneia.com,http://localhost:3000",
} = process.env;

// ---------- DB SQLite (simple & fiable)
const db = new Database(path.join(__dirname, "philo.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    credits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const upsertUser = db.prepare(`
  INSERT INTO users (id, email, credits)
  VALUES (@id, @email, @credits)
  ON CONFLICT(id) DO UPDATE SET email = excluded.email;
`);
const getUser = db.prepare(`SELECT id, email, credits FROM users WHERE id = ?`);
const setCredits = db.prepare(`UPDATE users SET credits = ? WHERE id = ?`);

// ---------- App
const app = express();

// CORS
const allowlist = ALLOW_ORIGINS.split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, allowlist.includes(origin));
  },
  credentials: true,
}));

// IMPORTANT: garder le rawBody pour vérifier la signature du webhook
app.use("/webhooks/clerk", bodyParser.raw({ type: "*/*" }));
app.use(express.json());

// ---------- Webhook Clerk : user.created => crédits de départ
app.post("/webhooks/clerk", async (req, res) => {
  try {
    const svix_id = req.headers["svix-id"];
    const svix_timestamp = req.headers["svix-timestamp"];
    const svix_signature = req.headers["svix-signature"];
    if (!svix_id || !svix_timestamp || !svix_signature) {
      return res.status(400).send("Missing svix headers");
    }

    const wh = new Webhook(CLERK_WEBHOOK_SECRET);
    const evt = wh.verify(req.body, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    });

    if (evt.type === "user.created") {
      const id = evt.data.id;
      const email =
        (evt.data.email_addresses?.[0]?.email_address) ||
        (evt.data.primary_email_address_id &&
          evt.data.email_addresses?.find(e => e.id === evt.data.primary_email_address_id)?.email_address) ||
        null;

      // upsert + crédits de départ si nouveau
      const existing = getUser.get(id);
      if (!existing) {
        upsertUser.run({ id, email, credits: Number(FREE_AFTER_SIGNUP) || 5000 });
        console.log(`✅ Nouvel utilisateur ${id} crédité de ${FREE_AFTER_SIGNUP} tokens.`);
      } else {
        upsertUser.run({ id, email, credits: existing.credits });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook Clerk error:", err?.message || err);
    res.status(400).send("Invalid signature");
  }
});

// ---------- Middleware userId (simple & efficace)
// Le front enverra l’entête:  x-user-id: Clerk.user.id
function requireUser(req, res, next) {
  const uid = req.headers["x-user-id"];
  if (!uid) return res.status(401).json({ error: "Missing x-user-id" });
  req.userId = uid;
  next();
}

// ---------- Route solde
app.get("/api/credits", requireUser, (req, res) => {
  const u = getUser.get(req.userId);
  if (!u) return res.json({ credits: 0 });
  res.json({ credits: u.credits });
});

// ---------- Route chat: facture tokens réels
app.post("/api/chat", requireUser, async (req, res) => {
  try {
    const { message, images } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message requis" });
    }
    const user = getUser.get(req.userId) || { id: req.userId, email: null, credits: 0 };
    if (!user.id) {
      // si inconnu (aucun webhook reçu), on crée à zéro
      upsertUser.run({ id: req.userId, email: null, credits: 0 });
    }

    if (user.credits <= 0) {
      return res.status(402).json({ error: "Solde insuffisant", credits: user.credits });
    }

    // Prépare le contenu multimodal si des images (URLs base64) arrivent
    const contents = [{ type: "text", text: message }];
    if (Array.isArray(images)) {
      for (const img of images) {
        contents.push({
          type: "input_image",
          image_url: img, // data:image/png;base64,... ou URL publique
        });
      }
    }

    // Appel OpenAI
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Tu es Philomène IA, un assistant personnel. Réponds simplement, en français si l’utilisateur écrit en français, sinon dans sa langue.",
          },
          { role: "user", content: contents },
        ],
        temperature: 0.3,
      }),
    });

    const data = await aiResp.json();
    if (!aiResp.ok) {
      console.error("OpenAI error:", data);
      return res.status(aiResp.status).json({ error: "OpenAI error", details: data });
    }

    // Tokens consommés
    const used = data?.usage?.total_tokens ?? 0;

    // Déduction
    const newCredits = Math.max(0, (user.credits ?? 0) - used);
    setCredits.run(newCredits, req.userId);

    const reply = data.choices?.[0]?.message?.content || "(réponse vide)";

    res.json({
      reply,
      used_tokens: used,
      credits_left: newCredits,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------- Démarrage
app.listen(PORT, () => {
  console.log(`✅ Backend Philomène démarré sur : ${PORT}`);
});
