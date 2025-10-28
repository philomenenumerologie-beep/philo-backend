import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Sécurité sessions + tokens de connexion
import jwt from "jsonwebtoken";
import { Resend } from "resend";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ✅ CORS sécurisé
const allowedOrigins = JSON.parse(process.env.ALLOW_ORIGINS || "[]");
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true
  })
);

// ✅ RESEND init
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Page test
app.get("/", (req, res) => {
  res.send("API Philomenia OK");
});

// ✅ Vérifier solde
app.get("/balance", (req, res) => {
  res.json({
    free: Number(process.env.FREE_ANON || 1000),
    paid: 0,
    total: Number(process.env.FREE_ANON || 1000),
    mode: "guest"
  });
});

// ✅ Config publique pour le front
app.get("/config", (req, res) => {
  res.json({
    paymentEnabled: process.env.PAYMENT_ENABLED === "true",
    freeAnon: Number(process.env.FREE_ANON || 1000),
    freeAfterSignup: Number(process.env.FREE_AFTER_SIGNUP || 2000),
  });
});

// ✅ LOGIN PAR EMAIL → ENVOI CODE
app.post("/auth/request-code", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email manquant" });

  const token = jwt.sign(
    { email },
    process.env.SESSION_SECRET,
    { expiresIn: "15m" }
  );

  const magicUrl = `${process.env.PUBLIC_API_URL}/auth/verify?token=${token}`;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Votre accès Philomenia 🪄",
      html: `<p>Cliquez ici pour vous connecter :</p>
             <a href="${magicUrl}">${magicUrl}</a>`
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur d’envoi email" });
  }
});

// ✅ VÉRIFICATION DU CODE → CONNECTÉ ✅
app.get("/auth/verify", (req, res) => {
  const { token } = req.query;
  try {
    jwt.verify(token, process.env.SESSION_SECRET);
    res.send("<h2>Connexion réussie ✅ Vous pouvez retourner sur l'app.</h2>");
  } catch (err) {
    res.status(400).send("Lien expiré ❌");
  }
});

// ✅ CHAT GPT-4
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL,
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();
    res.json({ reply: data?.choices?.[0]?.message?.content || "Erreur modèle" });
  } catch (err) {
    res.status(500).json({ error: "Erreur GPT" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("✅ Backend Philomenia running on port", PORT)
);
