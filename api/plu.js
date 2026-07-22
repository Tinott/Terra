/* ─────────────────────────────────────────────────────────────────────────
   Relais API Claude pour Vercel — extraction des règles de PLU depuis un texte.
   Équivalent de netlify/functions/plu.js, adapté au format Vercel.
   La clé API reste côté serveur (variable d'environnement ANTHROPIC_API_KEY).

   Appel depuis le front : POST /api/plu   body: { texte, zone }
   ───────────────────────────────────────────────────────────────────────── */

const PROMPT = `Tu extrais les règles de constructibilité d'un règlement de PLU français.

RÈGLES ABSOLUES :
1. Tu ne renvoies QUE ce que le texte dit. Si une règle n'est pas mentionnée, tu mets null. Ne devine JAMAIS.
2. Chaque valeur extraite est accompagnée d'une citation VERBATIM du texte (30 mots max) et d'une confiance entre 0 et 1.
3. Si le texte est ambigu (hauteur "au terrain naturel" sans point de mesure, règle conditionnelle...), lecture PRUDENTE, confiance BASSE, ambiguïté décrite.
4. Confiance 1 = chiffre explicite, sans condition ni exception. C'est rare.
5. Attention aux PLU "modernisés" (type Toulouse) : si hauteur/emprise/pleine terre sont renvoyées à un "système d'étiquettes" ou "règles graphiques", elles NE SONT PAS dans le texte → null + note. En revanche mixité sociale, bandes de constructibilité et conditions d'implantation SONT souvent dans le texte : extrais-les.

Réponds UNIQUEMENT en JSON, sans backticks, sans préambule :
{
  "zone": "code",
  "libelle_zone": "intitulé si présent",
  "destination_habitat_autorisee": true|false|null,
  "regles": {
    "hauteur_max_m":              {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "hauteur_max_niveaux":        {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "emprise_au_sol_max":         {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "recul_voie_m":               {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "recul_limites_sep_m":        {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "pleine_terre_min":           {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "stationnement_par_logt":     {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "mixite_sociale":             {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "densite_max_sdp_m2_par_m2":  {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""}
  },
  "ambiguites": [ {"regle": "...", "probleme": "...", "impact": "..."} ]
}

Les ratios (emprise, pleine terre, mixité) en DÉCIMAL : 40 % → 0.4.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Méthode non autorisée');

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY non configurée sur Vercel' });

  const { texte, zone } = req.body || {};
  if (!texte) return res.status(400).json({ erreur: 'texte manquant' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: `${PROMPT}\n\nZone recherchée : ${zone || 'à déterminer'}\n\nRÈGLEMENT :\n${String(texte).slice(0, 45000)}` }],
      }),
    });
    const data = await r.json();
    const brut = (data.content || []).map((c) => c.text || '').join('\n').replace(/```json|```/g, '').trim();
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(brut);
  } catch (e) {
    return res.status(502).json({ erreur: 'échec appel Claude', detail: String(e) });
  }
}
