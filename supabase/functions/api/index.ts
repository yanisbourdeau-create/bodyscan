// Bodyscan API — Supabase Edge Function
// Actions: "me" (abonnement), "analyze" (scan photo IA), "coach" (coach IA)
// Secrets requis : ANTHROPIC_API_KEY, WHOP_API_KEY, WHOP_ACCOUNT_ID
// Optionnels : WHOP_PLAN_PRO, WHOP_PLAN_PREMIUM, WHOP_PLAN_ELITE (IDs plan_xxx ou prod_xxx, séparés par des virgules)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE);
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5-20250514";
const RANK: Record<string, number> = { pro: 1, premium: 2, elite: 3 };
const PRO_MONTHLY_SCANS = 5;

// Admin emails — accès Elite gratuit (propriétaire)
const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") || "fdbyanis@gmail.com").toLowerCase().split(",").map(e => e.trim());

const ids = (k: string) => (Deno.env.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);

function tierOf(m: any): string | null {
  const pid = m?.plan?.id, prid = m?.product?.id;
  for (const t of ["elite", "premium", "pro"]) {
    const list = ids("WHOP_PLAN_" + t.toUpperCase());
    if (list.includes(pid) || list.includes(prid)) return t;
  }
  const title = String(m?.product?.title || m?.plan?.title || "").toLowerCase();
  if (title.includes("elite")) return "elite";
  if (title.includes("premium")) return "premium";
  if (title.includes("pro")) return "pro";
  return null;
}

// Cherche un abonnement Whop actif pour cet email (cache 10 min en base)
async function getPlan(email: string): Promise<string | null> {
  const em = email.toLowerCase();
  // Admin bypass — accès Elite sans abonnement Whop
  if (ADMIN_EMAILS.includes(em)) return "elite";
  const { data: cached } = await admin.from("subscriptions").select("*").eq("email", em).maybeSingle();
  if (cached && Date.now() - new Date(cached.checked_at).getTime() < 10 * 60 * 1000) return cached.plan;

  const key = Deno.env.get("WHOP_API_KEY"), acc = Deno.env.get("WHOP_ACCOUNT_ID");
  if (!key || !acc) throw new Error("Whop non configuré");
  let best: string | null = null, after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const u = new URL("https://api.whop.com/api/v1/memberships");
    u.searchParams.set("account_id", acc);
    u.searchParams.set("first", "100");
    for (const s of ["active", "trialing", "past_due", "canceling"]) u.searchParams.append("statuses", s);
    if (after) u.searchParams.set("after", after);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error("Whop " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const m of j.data || []) {
      if (String(m?.user?.email || "").toLowerCase() !== em) continue;
      const t = tierOf(m) || "pro";
      if (!best || RANK[t] > RANK[best]) best = t;
    }
    if (!j.page_info?.has_next_page) break;
    after = j.page_info.end_cursor;
  }
  await admin.from("subscriptions").upsert({ email: em, plan: best, checked_at: new Date().toISOString() });
  return best;
}

async function claude(system: string, content: any[], maxTokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error("IA " + r.status + " " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return (j.content || []).map((c: any) => c.text || "").join("");
}

const SCAN_SYSTEM = `Tu es l'analyste morphologique de Bodyscan, une app fitness francophone.
On te donne UNE photo d'une personne (corps entier, de face idéalement) + taille, poids, sexe, âge.
Ta mission : estimer visuellement le morphotype et la composition corporelle, avec prudence et honnêteté.
Règles :
- Si la photo ne montre pas clairement un corps humain (visage seul, objet, photo floue, plusieurs personnes), renvoie {"error":"<raison courte en français>"}.
- Si la photo semble montrer un mineur ou une personne dénudée, renvoie {"error":"Photo non acceptée. Utilise une photo en tenue de sport, adulte uniquement."}.
- Les estimations visuelles sont approximatives : reste réaliste, ne flatte pas, ne juge pas.
- Ne note QUE les muscles réellement visibles sur la photo.
Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format :
{"morphotype":"ECTOMORPHE"|"MÉSOMORPHE"|"ENDOMORPHE",
 "type":"<ex: Profil athlétique>",
 "strengths":"<2-3 points forts, courts>",
 "description":"<3-4 phrases en tutoyant : ce que tu observes sur la photo + priorités d'entraînement>",
 "bodyFatPct":<nombre, estimation visuelle>,
 "symmetry":<0-100>,
 "shoulderRatio":<ratio épaules/taille estimé, ex 1.45>,
 "muscles":[{"name":"<muscle>","zone":"épaules|torse|bras|jambes|dos","score":<0-100 développement visible>}],
 "proportions":{"epaules":<0-100>,"poitrine":<0-100>,"taille":<0-100>,"hanches":<0-100>,"jambes":<0-100>},
 "photoQuality":"bonne|moyenne|faible"}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: ud, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !ud?.user?.email) return json({ error: "Non connecté" }, 401);
    const u = ud.user;
    const body = await req.json().catch(() => ({}));
    const plan = await getPlan(u.email!);

    if (body.action === "me") {
      const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
      const { count } = await admin.from("scans").select("id", { count: "exact", head: true })
        .eq("user_id", u.id).gte("created_at", since.toISOString());
      return json({ plan, monthScans: count || 0, limit: plan === "pro" ? PRO_MONTHLY_SCANS : null });
    }

    if (!plan) return json({ error: "Aucun abonnement actif", code: "no_plan" }, 402);

    if (body.action === "analyze") {
      const { image, height, weight, sex, age } = body;
      if (!image || !height || !weight) return json({ error: "Photo, taille et poids requis" }, 400);
      if (plan === "pro") {
        const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
        const { count } = await admin.from("scans").select("id", { count: "exact", head: true })
          .eq("user_id", u.id).gte("created_at", since.toISOString());
        if ((count || 0) >= PRO_MONTHLY_SCANS) return json({ error: "Limite de 5 scans/mois atteinte. Passe en Premium pour des scans illimités.", code: "limit" }, 429);
      }
      const m = String(image).match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
      if (!m) return json({ error: "Format d'image invalide" }, 400);
      if (m[3].length > 6_000_000) return json({ error: "Image trop lourde" }, 413);
      const txt = await claude(SCAN_SYSTEM, [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[3] } },
        { type: "text", text: `Taille: ${height} cm. Poids: ${weight} kg. Sexe: ${sex === "female" ? "femme" : "homme"}. Âge: ${age || "non précisé"}.` },
      ]);
      let r: any;
      try { r = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); }
      catch { return json({ error: "Analyse impossible, réessaie avec une autre photo." }, 502); }
      if (r.error) return json({ error: r.error, code: "bad_photo" }, 422);
      const okM = ["ECTOMORPHE", "MÉSOMORPHE", "ENDOMORPHE"];
      if (!okM.includes(r.morphotype)) r.morphotype = "MÉSOMORPHE";
      const h = +height, w = +weight, a = +age || 30;
      r.bmi = (w / ((h / 100) ** 2)).toFixed(1);
      r.bmr = Math.round(10 * w + 6.25 * h - 5 * a + (sex === "female" ? -161 : 5)); // Mifflin-St Jeor
      await admin.from("scans").insert({ user_id: u.id, result: r });
      return json({ result: r });
    }

    if (body.action === "coach") {
      if (plan !== "elite") return json({ error: "Le coach IA est réservé au plan Elite", code: "tier" }, 403);
      const msg = String(body.message || "").slice(0, 1500);
      if (!msg) return json({ error: "Message vide" }, 400);
      const hist = (Array.isArray(body.history) ? body.history : []).slice(-8)
        .map((h: any) => `${h.role === "user" ? "Utilisateur" : "Coach"}: ${String(h.text).slice(0, 800)}`).join("\n");
      const ctx = body.lastScan ? `Dernier scan de l'utilisateur : ${JSON.stringify(body.lastScan).slice(0, 1500)}` : "Pas encore de scan.";
      const reply = await claude(
        `Tu es le coach IA de Bodyscan : coach sportif et nutrition francophone, tutoiement, ton motivant mais honnête, réponses courtes (max 120 mots), concrètes et actionnables. Tu n'es pas médecin : pour douleur, blessure, maladie ou troubles alimentaires, oriente vers un professionnel de santé. ${ctx}`,
        [{ type: "text", text: (hist ? hist + "\n" : "") + "Utilisateur: " + msg }],
        600,
      );
      return json({ reply });
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur : " + (e as Error).message }, 500);
  }
});
