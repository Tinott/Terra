/* ─────────────────────────────────────────────────────────────────────────
   Proxy CORS pour Vercel — relaie les appels vers les API publiques d'urbanisme.
   Équivalent de netlify/functions/proxy.js, adapté au format Vercel
   (export default (req, res) au lieu de exports.handler = async (event)).

   Appel depuis le front : /api/proxy?url=<URL_ENCODÉE>
   ───────────────────────────────────────────────────────────────────────── */

const DOMAINES_AUTORISES = [
  'apicarto.ign.fr',
  'georisques.gouv.fr',
  'api-adresse.data.gouv.fr',
  'data.geopf.fr',
  'wxs.ign.fr',
  'data.economie.gouv.fr',
  'api.cquest.org',
  'app.dvf.etalab.gouv.fr',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const cible = req.query.url;
  if (!cible) return res.status(400).json({ erreur: 'paramètre url manquant' });

  let u;
  try { u = new URL(cible); } catch { return res.status(400).json({ erreur: 'url invalide' }); }

  if (!DOMAINES_AUTORISES.includes(u.hostname))
    return res.status(403).json({ erreur: `domaine non autorisé : ${u.hostname}` });

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 14000);
    const r = await fetch(cible, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'TERRA/1.0' } });
    clearTimeout(t);
    const texte = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(texte);
  } catch (e) {
    return res.status(502).json({ erreur: 'échec de la requête amont', detail: String(e) });
  }
}
