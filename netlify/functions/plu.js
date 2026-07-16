/* ─────────────────────────────────────────────────────────────────────────
   Relais API Claude — extraction des règles de PLU depuis un texte.
   La clé API reste côté serveur (variable d'environnement ANTHROPIC_API_KEY),
   jamais exposée au navigateur.

   Appel depuis le front :
     POST /api/plu   body: { texte, zone }
   Réponse : le JSON structuré des règles (voir PROMPT).
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

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Méthode non autorisée' };

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return { statusCode: 500, headers: CORS, body: JSON.stringify({ erreur: 'ANTHROPIC_API_KEY non configurée sur Netlify' }) };

  let texte, zone;
  try { ({ texte, zone } = JSON.parse(event.body || '{}')); } catch { return { statusCode: 400, headers: CORS, body: 'JSON invalide' }; }
  if (!texte) return { statusCode: 400, headers: CORS, body: JSON.stringify({ erreur: 'texte manquant' }) };

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
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: brut };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ erreur: 'échec appel Claude', detail: String(e) }) };
  }
};
