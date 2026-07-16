/* ─────────────────────────────────────────────────────────────────────────
   Proxy CORS — relaie les appels vers les API publiques d'urbanisme.
   Le navigateur ne peut pas appeler ces domaines directement (CORS).
   Cette fonction s'exécute côté serveur, où cette limite n'existe pas.

   Appel depuis le front :
     /api/proxy?url=<URL_ENCODÉE>
   Seuls les domaines de la liste blanche sont autorisés.
   ───────────────────────────────────────────────────────────────────────── */

const DOMAINES_AUTORISES = [
  'apicarto.ign.fr',
  'georisques.gouv.fr',
  'api-adresse.data.gouv.fr',
  'data.geopf.fr',
  'wxs.ign.fr',
  'data.economie.gouv.fr',
];

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const cible = event.queryStringParameters && event.queryStringParameters.url;
  if (!cible) return { statusCode: 400, headers: CORS, body: JSON.stringify({ erreur: 'paramètre url manquant' }) };

  let u;
  try { u = new URL(cible); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ erreur: 'url invalide' }) }; }

  if (!DOMAINES_AUTORISES.includes(u.hostname))
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ erreur: `domaine non autorisé : ${u.hostname}` }) };

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 14000);
    const r = await fetch(cible, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'TERRA/1.0' } });
    clearTimeout(t);
    const texte = await r.text();
    return {
      statusCode: r.status,
      headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' },
      body: texte,
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ erreur: 'échec de la requête amont', detail: String(e) }) };
  }
};
