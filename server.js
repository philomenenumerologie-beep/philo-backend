import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "10mb" }));

// CORS
const ORIGINS = (process.env.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb)=> { if(!origin) return cb(null,true); if(ORIGINS.includes(origin)) return cb(null,true); return cb(null,true); /* autorise tout si besoin */ },
}));

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Quotas & tokens (mémoire simple) ===
const initialFree = 2000;            // tokens gratuits
const maxTokensPerMsg = 1000;        // garde-fou par message
const usage = {}; // { clientId: { month:'YYYYMM', free: remaining, paid: remaining } }

function ymNow(){ const d=new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function ensureClient(clientId){
  const m=ymNow(); usage[clientId] ||= { month:m, free:initialFree, paid:0 };
  if(usage[clientId].month!==m){ usage[clientId]={ month:m, free:initialFree, paid:usage[clientId].paid }; }
  return usage[clientId];
}
function approxTokens(str){ return Math.ceil((str||"").length/4); }

// Packs (prix EUR → tokens crédités)
const PACKS = {
  PACK_5:  { amount:"5.00",  tokens:4000 },
  PACK_10: { amount:"10.00", tokens:9000 },
  PACK_20: { amount:"20.00", tokens:20000 },
};

// === Routes simples ===
app.get("/health", (_req,res)=>res.json({ ok:true }));
app.get("/api/quota", (req,res)=>{
  const u = ensureClient(req.headers["x-client-id"]||"anon");
  res.json({ tier: u.paid>0 ? "paid" : "free", remaining: (u.free+u.paid) });
});

// Actualités via Serper
app.get("/api/news", async (req,res)=>{
  try{
    const q = (req.query.q||"").toString().trim();
    if(!q) return res.status(400).json({ error:"Paramètre q requis" });
    const r = await fetch("https://google.serper.dev/news",{
      method:"POST",
      headers:{ "X-API-KEY":process.env.SERPER_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify({ q })
    });
    const j = await r.json();
    const items = (j.news||[]).slice(0,3).map(it=>({ title:it.title, link:it.link, date:it.date }));
    res.json({ results: items });
  }catch(e){ console.error(e); res.status(500).json({ error:"Erreur actu" }); }
});

// Chat
app.post("/api/chat", async (req,res)=>{
  try{
    const clientId = req.headers["x-client-id"]||"anon";
    const lang = (req.headers["x-lang"]||"fr").toString();
    const { message, image } = req.body||{};
    if(!message || typeof message!=="string") return res.status(400).json({ error:"message requis" });

    const u = ensureClient(clientId);
    const estimate = Math.min(maxTokensPerMsg, approxTokens(message));
    if((u.free+u.paid) <= 0) return res.status(402).json({ error:"Quota atteint" });

    // Sélection modèle (on reste sur gpt-4o-mini pour coût, basculable si u.paid>0)
    const model = "gpt-4o-mini"; // tu peux mettre un modèle plus costaud si u.paid>0

    const userParts = [{ type:"text", text: message }];
    if(image && /^data:image\/(png|jpe?g);base64,/.test(image)){
      userParts.push({ type:"input_image", image_url: { url: image } });
    }

    const completion = await openai.chat.completions.create({
      model,
      max_tokens: 800,
      messages: [
        { role:"system", content:`Tu es Philomène, utile, précise, style clair. Réponds en ${lang}.` },
        { role:"user", content: userParts }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || "(pas de réponse)";

    // débit tokens (d'abord le free puis le paid)
    let cost = approxTokens(message + reply);
    cost = Math.min(cost, (u.free+u.paid));
    const fromFree = Math.min(cost, u.free); u.free -= fromFree; u.paid -= (cost-fromFree);

    res.json({ reply, quota:{ remaining: u.free+u.paid } });
  }catch(e){ console.error("chat error", e); res.status(500).json({ error:"Erreur serveur" }); }
});

// === PayPal (create + capture) ===
const PP_BASE = process.env.PAYPAL_MODE==="live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
async function paypalToken(){
  const r = await fetch(PP_BASE+"/v1/oauth2/token",{
    method:"POST",
    headers:{ "Authorization":"Basic "+Buffer.from(process.env.PAYPAL_CLIENT_ID+":"+process.env.PAYPAL_SECRET).toString("base64"), "Content-Type":"application/x-www-form-urlencoded" },
    body:"grant_type=client_credentials"
  });
  const j = await r.json(); return j.access_token;
}
// crée une commande pour un pack
app.post("/api/paypal/create-order", async (req,res)=>{
  try{
    const { packId } = req.body||{};
    const pack = PACKS[packId]; if(!pack) return res.status(400).json({ error:"pack invalide" });
    const tok = await paypalToken();
    const r = await fetch(PP_BASE+"/v2/checkout/orders",{
      method:"POST",
      headers:{ "Authorization":"Bearer "+tok, "Content-Type":"application/json" },
      body: JSON.stringify({
        intent:"CAPTURE",
        purchase_units:[{ amount:{ currency_code:"EUR", value: pack.amount }, custom_id: packId }]
      })
    });
    const j = await r.json(); res.json({ id:j.id });
  }catch(e){ console.error(e); res.status(500).json({ error:"paypal create" }); }
});

// capture + crédit tokens
app.post("/api/paypal/capture-order", async (req,res)=>{
  try{
    const clientId = req.headers["x-client-id"]||"anon";
    const { orderId } = req.body||{};
    const tok = await paypalToken();
    const r = await fetch(PP_BASE+`/v2/checkout/orders/${orderId}/capture`,{
      method:"POST", headers:{ "Authorization":"Bearer "+tok, "Content-Type":"application/json" }
    });
    const j = await r.json();
    const unit = j?.purchase_units?.[0];
    const cap = unit?.payments?.captures?.[0];
    const amount = cap?.amount?.value;
    const packId = unit?.custom_id;
    const pack = Object.values(PACKS).find(p=>p.amount===amount) || PACKS[packId];
    if(cap?.status!=="COMPLETED" || !pack) return res.json({ ok:false });

    // crédit
    const u = ensureClient(clientId);
    u.paid += pack.tokens;
    res.json({ ok:true, added: pack.tokens, remaining: u.free+u.paid });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:"paypal capture" }); }
});

app.listen(PORT, ()=> console.log("✅ Backend en ligne sur le port", PORT));
