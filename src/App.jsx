import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

/* ══════════════════════════════════════════════════════════════════════════
   TERRA — Criblage foncier
   Un outil de tri. Il dit non vite, et il dit pourquoi.
   ══════════════════════════════════════════════════════════════════════════ */

/* En production Netlify (voie Git), tout passe par le proxy serveur pour
   contourner le CORS. En déploiement statique (drag-and-drop) ou en local,
   il n'y a pas de backend : on tente en direct, ça échoue souvent → saisie
   manuelle, ce qui est géré proprement. On sonde le backend une fois. */
let BACKEND = null; // null = inconnu, true/false une fois testé
async function backendDispo() {
  if (BACKEND !== null) return BACKEND;
  try {
    const r = await fetch('/api/proxy?url=' + encodeURIComponent('https://api-adresse.data.gouv.fr/search/?q=paris&limit=1'), { method: 'GET' });
    BACKEND = r.ok;
  } catch { BACKEND = false; }
  return BACKEND;
}
const PROXY = '/api/proxy?url=';
const via = (url) => (BACKEND ? PROXY + encodeURIComponent(url) : url);

const API = {
  adresse:  'https://api-adresse.data.gouv.fr/search',
  cadastre: 'https://apicarto.ign.fr/api/cadastre/parcelle',
  gpuZone:  'https://apicarto.ign.fr/api/gpu/zone-urba',
  gpuPresc: 'https://apicarto.ign.fr/api/gpu/prescription-surf',
  gpuSup:   'https://apicarto.ign.fr/api/gpu/assiette-sup-s',
  gpuMuni:  'https://apicarto.ign.fr/api/gpu/municipality',
  risques:  'https://georisques.gouv.fr/api/v1/resultats_rapport_risque',
};

const F = { API: 'api', LLM: 'llm', HUMAIN: 'humain', DEFAUT: 'defaut', ABSENT: 'absent' };
const F_LABEL = { api: 'API', llm: 'IA', humain: 'Saisi', defaut: 'Défaut', absent: 'Manquant' };

const V = (val, o = {}) => ({
  val, unite: o.unite || '',
  fiab: o.fiab || (val === null || val === undefined ? F.ABSENT : F.DEFAUT),
  conf: o.conf ?? 1, min: o.min ?? null, max: o.max ?? null,
  source: o.source || '', citation: o.citation || '', note: o.note || '',
});
const connue = (v) => v && v.val !== null && v.val !== undefined && v.fiab !== F.ABSENT;
const bornes = (v) => {
  if (!connue(v)) return [0, 0, 0];
  const k = 0.25 * (1 - v.conf);
  return [v.min ?? v.val * (1 - k), v.val, v.max ?? v.val * (1 + k)];
};

/* ═══ HYPOTHÈSES — presets, jamais de valeur en dur dans le calcul ═══ */
const H_BASE = {
  prix_vente_m2:       { v: 4200,  p10: 3400,  p90: 5200,  u: '€/m² SHAB',   g: 'Recettes',  lib: 'Prix de vente',              aide: 'TTC, hors parking.' },
  part_sdp_shab:       { v: 0.86,  p10: 0.82,  p90: 0.90,  u: 'ratio',       g: 'Recettes',  lib: 'SHAB / SDP',                 aide: 'Surface vendable / surface de plancher.' },
  prix_parking:        { v: 15000, p10: 10000, p90: 22000, u: '€/place',     g: 'Recettes',  lib: 'Vente parking',              aide: 'Mettre 0 si non commercialisés.' },
  cout_travaux_m2:     { v: 1850,  p10: 1600,  p90: 2200,  u: '€/m² SDP',    g: 'Coûts',     lib: 'Construction',               aide: 'TCE, hors VRD et fondations spéciales.' },
  cout_parking:        { v: 18000, p10: 12000, p90: 28000, u: '€/place',     g: 'Coûts',     lib: 'Coût par place',             aide: 'Sous-sol nettement plus cher qu\'aérien.' },
  cout_demolition_m2:  { v: 120,   p10: 70,    p90: 250,   u: '€/m²',        g: 'Coûts',     lib: 'Démolition',                 aide: 'Hors désamiantage.' },
  vrd_forfait:         { v: 60000, p10: 30000, p90: 150000,u: '€',           g: 'Coûts',     lib: 'VRD et aménagements',        aide: 'Voiries, réseaux, espaces verts.' },
  honoraires_moe:      { v: 0.11,  p10: 0.09,  p90: 0.14,  u: '× travaux',   g: 'Coûts',     lib: 'Maîtrise d\'œuvre',          aide: 'Architecte, BET, OPC.' },
  honoraires_promo:    { v: 0.05,  p10: 0.04,  p90: 0.07,  u: '× CA',        g: 'Coûts',     lib: 'Honoraires de promotion',    aide: 'Rémunération interne.' },
  commercialisation:   { v: 0.05,  p10: 0.03,  p90: 0.07,  u: '× CA',        g: 'Coûts',     lib: 'Commercialisation',          aide: 'Commissions et marketing.' },
  frais_financiers:    { v: 0.04,  p10: 0.025, p90: 0.06,  u: '× CA',        g: 'Coûts',     lib: 'Frais financiers',           aide: 'Portage sur la durée d\'opération.' },
  assurances:          { v: 0.02,  p10: 0.015, p90: 0.03,  u: '× travaux',   g: 'Coûts',     lib: 'Assurances',                 aide: 'Dommages-ouvrage, RC.' },
  alea:                { v: 0.05,  p10: 0.03,  p90: 0.10,  u: '× travaux',   g: 'Coûts',     lib: 'Aléas',                      aide: 'Provision pour imprévus.' },
  taxe_amenagement_m2: { v: 950,   p10: 850,   p90: 1100,  u: '€/m² taxable',g: 'Taxes',     lib: 'Valeur forfaitaire TA',      aide: 'Base de calcul de la taxe d\'aménagement.' },
  taux_ta:             { v: 0.05,  p10: 0.03,  p90: 0.08,  u: 'taux',        g: 'Taxes',     lib: 'Taux TA cumulé',             aide: 'Part communale + départementale.' },
  marge_cible:         { v: 0.10,  p10: 0.08,  p90: 0.12,  u: '× CA HT',     g: 'Décision',  lib: 'Marge cible',                aide: 'Sous ce seuil, l\'opération ne se fait pas.' },
  frais_acquisition:   { v: 0.08,  p10: 0.07,  p90: 0.09,  u: '× charge f.', g: 'Décision',  lib: 'Frais d\'acquisition',       aide: 'Notaire, droits, commission foncière.' },
  surface_moy_logt:    { v: 62,    p10: 52,    p90: 75,    u: 'm² SHAB',     g: 'Programme', lib: 'Surface moyenne / logement', aide: 'Dépend du mix typologique.' },
  decote_social:       { v: 0.45,  p10: 0.35,  p90: 0.55,  u: 'décote',      g: 'Programme', lib: 'Décote logement social',     aide: '0,45 → vendu 55 % du prix libre au bailleur.' },
  sps_seuil_m2:        { v: 1000,  p10: 1000,  p90: 1000,  u: 'm² SDP',      g: 'Programme', lib: 'Seuil mixité sociale',       aide: 'SDP au-delà de laquelle le logement social devient obligatoire. Détecté automatiquement quand le PLU le publie.' },
  sps_taux:            { v: 0.40,  p10: 0.35,  p90: 0.40,  u: 'ratio',       g: 'Programme', lib: 'Taux de logement social',    aide: 'Part imposée au-delà du seuil. 0,40 à Toulouse en secteur 1.' },
  seuil_sdp_min:       { v: 400,   p10: 400,   p90: 400,   u: 'm² SDP',      g: 'Décision',  lib: 'SDP minimale viable',        aide: 'En-dessous, pas d\'opération possible.' },
};

const REGIONS = {
  standard:  { nom: 'Standard national', delta: {} },
  idf:       { nom: 'Île-de-France',      delta: { prix_vente_m2: { v: 6800, p10: 5200, p90: 9500 }, cout_travaux_m2: { v: 2200, p10: 1900, p90: 2700 }, cout_parking: { v: 28000, p10: 20000, p90: 40000 }, taxe_amenagement_m2: { v: 1050 } } },
  metropole: { nom: 'Grande métropole',   delta: { prix_vente_m2: { v: 4900, p10: 4000, p90: 6200 }, cout_travaux_m2: { v: 1950, p10: 1700, p90: 2350 } } },
  littoral:  { nom: 'Littoral tendu',     delta: { prix_vente_m2: { v: 6200, p10: 4800, p90: 9000 }, cout_travaux_m2: { v: 2050, p10: 1800, p90: 2500 } } },
  ville_moy: { nom: 'Ville moyenne',      delta: { prix_vente_m2: { v: 3100, p10: 2500, p90: 3900 }, cout_travaux_m2: { v: 1750, p10: 1550, p90: 2050 }, cout_parking: { v: 12000 } } },
  rural:     { nom: 'Rural / détendu',    delta: { prix_vente_m2: { v: 2300, p10: 1800, p90: 3000 }, cout_travaux_m2: { v: 1700, p10: 1500, p90: 2000 }, marge_cible: { v: 0.12 } } },
};

const buildJeu = (rk) => {
  const b = JSON.parse(JSON.stringify(H_BASE));
  Object.entries(REGIONS[rk]?.delta || {}).forEach(([k, p]) => { if (b[k]) Object.assign(b[k], p); });
  Object.values(b).forEach((h) => { h.src = 'preset'; });
  return b;
};

/* ═══ FORMAT ═══ */
const eur = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)} M€`;
  if (a >= 1e3) return `${Math.round(n / 1e3)} k€`;
  return `${Math.round(n)} €`;
};
const num = (n, d = 0) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n, d = 0) => (n == null || !isFinite(n) ? '—' : `${(n * 100).toFixed(d)} %`);

/* ═══ STOCKAGE (localStorage — persistant dans le navigateur) ═══ */
const store = {
  async get(k, def = null) { try { const v = localStorage.getItem('terra:' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  async set(k, v) { try { localStorage.setItem('terra:' + k, JSON.stringify(v)); return true; } catch (e) { console.error(e); return false; } },
  async del(k) { try { localStorage.removeItem('terra:' + k); return true; } catch { return false; } },
  async list(p) { try { return Object.keys(localStorage).filter((x) => x.startsWith('terra:' + (p || ''))).map((x) => x.slice(6)); } catch { return []; } },
};

/* ═══ GÉOMÉTRIE ═══ */
const R_TERRE = 6371000;
const toXY = (coords) => {
  const lon0 = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const k = Math.PI / 180;
  return coords.map(([lon, lat]) => [
    R_TERRE * (lon - lon0) * k * Math.cos(lat0 * k),
    R_TERRE * (lat - lat0) * k,
  ]);
};
const aireXY = (p) => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(a / 2);
};
const anneauExt = (geom) => {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates[0];
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((best, poly) => {
      const a = aireXY(toXY(poly[0]));
      return !best || a > best.a ? { a, r: poly[0] } : best;
    }, null)?.r;
  }
  return null;
};
const surfaceGeom = (geom) => {
  const r = anneauExt(geom);
  return r ? aireXY(toXY(r)) : null;
};
/* Érosion par offset intérieur — approximation robuste par échantillonnage.
   Suffisant pour une enveloppe de capacité. Pas un solveur d'architecte. */
const eroder = (pts, d) => {
  if (d <= 0) return pts;
  const n = pts.length;
  const dedans = (x, y) => {
    let ok = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
    }
    return ok;
  };
  const distBord = (x, y) => {
    let m = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      const dx = xj - xi, dy = yj - yi;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / L2)) : 0;
      const px = xi + t * dx, py = yi + t * dy;
      m = Math.min(m, Math.hypot(x - px, y - py));
    }
    return m;
  };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const N = 90;
  const dx = (x1 - x0) / N, dy = (y1 - y0) / N;
  let aire = 0;
  const cell = dx * dy;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = x0 + (i + 0.5) * dx, y = y0 + (j + 0.5) * dy;
    if (dedans(x, y) && distBord(x, y) >= d) aire += cell;
  }
  return { aire };
};

/* ═══ RÉPARTITION MULTI-ZONE ═══
   Quand la parcelle est à cheval sur plusieurs zones, chaque portion obéit
   à SA zone. On calcule la part de surface de chacune par échantillonnage :
   grille de points sur la parcelle, test d'appartenance à chaque zone.
   En lon/lat sur <1 km, les proportions sont exactes. */

const dansPolygone = (lon, lat, anneaux) => {
  // pair-impair sur les anneaux d'UN SEUL polygone (exterieur + trous)
  let ok = false;
  for (const anneau of anneaux) {
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
      const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ok = !ok;
    }
  }
  return ok;
};

/* Retourne une liste de GROUPES d'anneaux — un groupe par polygone constitutif.
   Pour un MultiPolygon (fréquent pour une zone PLU faite de plusieurs patchs
   disjoints en ville), il NE FAUT PAS fusionner les anneaux de polygones
   différents dans un seul test pair-impair : ça produit un résultat faux
   (le test peut s'annuler entre polygones distincts). On garde les polygones
   séparés et on teste "dans l'un OU l'autre". */
const groupesDe = (geom) => {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates; // déjà un tableau de polygones
  return [];
};
const dansZone = (lon, lat, groupes) => groupes.some((g) => dansPolygone(lon, lat, g));

/* Zones à vocation d'activités économiques : logement interdit ou marginal. */
const RE_ZONE_ACTIVITES = /^(UIC|UI|UE|UF|UX|AUI|AUE)[a-z0-9]*$/i;

const repartirZones = (geomParcelle, zonesFeatures, surfaceTotale) => {
  const groupesP = groupesDe(geomParcelle);
  if (!groupesP.length || !zonesFeatures?.length) return null;
  // bbox de la parcelle
  const pts = groupesP.flat(2);
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const l0 = Math.min(...lons), l1 = Math.max(...lons);
  const t0 = Math.min(...lats), t1 = Math.max(...lats);
  const N = 50; // 2500 points — bonne précision, coût raisonnable
  const compte = {};
  let dedansTotal = 0;
  // Pré-calcul : groupes de polygones + bbox de chaque zone pour rejet rapide
  const zonesG = zonesFeatures.map((z) => {
    const groupes = groupesDe(z.geometry);
    const zp = groupes.flat(2);
    return {
      lib: z.libelle, groupes,
      bx0: Math.min(...zp.map((p) => p[0])), bx1: Math.max(...zp.map((p) => p[0])),
      by0: Math.min(...zp.map((p) => p[1])), by1: Math.max(...zp.map((p) => p[1])),
    };
  });
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const lon = l0 + ((i + 0.5) / N) * (l1 - l0);
    const lat = t0 + ((j + 0.5) / N) * (t1 - t0);
    if (!dansZone(lon, lat, groupesP)) continue;
    dedansTotal++;
    for (const z of zonesG) {
      if (lon < z.bx0 || lon > z.bx1 || lat < z.by0 || lat > z.by1) continue; // rejet bbox
      if (z.groupes.length && dansZone(lon, lat, z.groupes)) { compte[z.lib] = (compte[z.lib] || 0) + 1; break; }
    }
  }
  if (!dedansTotal) return null;
  const rep = Object.entries(compte).map(([lib, n]) => ({
    zone: lib,
    part: n / dedansTotal,
    m2: Math.round((n / dedansTotal) * (surfaceTotale || 0)),
    activites: RE_ZONE_ACTIVITES.test(lib),
  })).sort((a, b) => b.part - a.part);
  const partResid = rep.filter((r) => !r.activites).reduce((s, r) => s + r.part, 0);
  return { repartition: rep, part_residentielle: partResid, m2_residentiel: Math.round(partResid * (surfaceTotale || 0)) };
};

/* ═══ ÉTAPE 2 — KILLERS ═══
   Seuils ASYMÉTRIQUES : jeter une pépite coûte l'opération,
   garder un mauvais terrain coûte une étude. On garde en cas de doute. */
const ZONES_MORTES = /^(N|A)[a-z0-9]*$/i;
const ZONES_DIFFEREES = /^(1?AU|2AU|AU)[a-z0-9]*$/i;

const chercherKillers = (d, jeu) => {
  const K = [];
  const push = (sev, code, msg, action = '') => K.push({ sev, code, msg, action });

  if (d.zonage && ZONES_MORTES.test(d.zonage))
    push('bloquant', 'ZONE_NA', `Zone ${d.zonage} — naturelle ou agricole. Habitat non constructible.`, 'Vérifier un éventuel secteur de taille et capacité d\'accueil limitées (STECAL).');

  if (d.zonage && ZONES_DIFFEREES.test(d.zonage))
    push('majeur', 'ZONE_AU', `Zone ${d.zonage} — à urbaniser. Ouverture conditionnée.`, 'Vérifier l\'OAP et les conditions d\'ouverture à l\'urbanisation.');

  /* Zone d'activités économiques : l'habitat y est interdit ou marginal. */
  if (d.zonage && RE_ZONE_ACTIVITES.test(d.zonage))
    push('majeur', 'ZONE_ACTIVITES', `Zone ${d.zonage} — vocation économique (activités, commerces, bureaux). Le logement y est en principe interdit ou très restreint.`,
      'Lire l\'article "destinations autorisées" du règlement de la zone. Si multi-zone, ne compter le logement que sur la portion résidentielle.');
  if (d.repartition?.repartition?.some((r) => r.activites) && !RE_ZONE_ACTIVITES.test(d.zonage))
    push('majeur', 'ZONE_ACTIVITES_PARTIELLE',
      `Une partie du terrain (${d.repartition.repartition.filter((r) => r.activites).map((r) => `${r.zone} ≈ ${num(r.m2)} m²`).join(', ')}) est en zone d'activités : logement exclu sur cette portion.`,
      'Le potentiel résidentiel est calculé sur la seule portion habitable.');

  if (!d.zonage && !d.zonage_absent_connu)
    push('vigilance', 'ZONE_INCONNUE', 'Zonage non récupéré. Absence de donnée ≠ absence de règle.', 'Vérifier manuellement sur le Géoportail de l\'urbanisme.');

  /* ── Interprétation experte des prescriptions ── */
  const libP = (p) => `${p.libelle || ''} ${p.typepsc || ''}`;

  const ebc = d.prescriptions.filter((p) => /espace.*bois|EBC/i.test(libP(p)));
  if (ebc.length) push('bloquant', 'EBC', `Espace boisé classé — ${ebc.length} prescription(s). Défrichement interdit.`, 'Mesurer la part réellement couverte : si elle est partielle, le reste peut rester constructible.');

  const er = d.prescriptions.filter((p) => /emplacement.*r[ée]serv|^ER\b/i.test(libP(p)));
  if (er.length) push('majeur', 'ER', `Emplacement réservé — ${er.length} prescription(s). Une partie du foncier est gelée pour un équipement ou une voie publique, potentiellement cessible à la collectivité.`, 'Mesurer l\'emprise gelée sur le plan de zonage ; elle est inconstructible.');

  const ebp = d.prescriptions.filter((p) => /b[âa]ti.*prot[ée]g|EBP|patrimoine|élément.*prot/i.test(libP(p)));
  if (ebp.length) push('majeur', 'EBP', 'Élément bâti protégé — démolition et modification très contraintes, insertion architecturale imposée.', 'Identifier précisément le bâti visé. Une démolition-reconstruction est probablement compromise sur cette emprise.');

  const sursis = d.prescriptions.filter((p) => /sursis/i.test(libP(p)));
  if (sursis.length) push('majeur', 'SURSIS', 'Périmètre de sursis à statuer — la collectivité peut suspendre toute demande de permis en attendant un projet d\'aménagement ou une évolution du PLU.', 'Interroger le service urbanisme sur le projet en cours et son calendrier avant tout engagement.');

  const dpu = d.prescriptions.filter((p) => /pr[ée]emption|DPU/i.test(libP(p)));
  if (dpu.length) push('vigilance', 'DPU', 'Droit de préemption urbain — la collectivité peut se substituer à l\'acquéreur lors de la vente (délai de 2 mois).', 'Aléa de délai et d\'issue à intégrer au calendrier d\'acquisition.');

  const peb = d.prescriptions.filter((p) => /exposition au bruit|PEB|a[ée]rodrome/i.test(libP(p)));
  if (peb.length) push('vigilance', 'PEB', 'Plan d\'exposition au bruit d\'aérodrome — isolation acoustique renforcée, restrictions possibles selon la zone du PEB.', 'Vérifier la zone du PEB (A/B/C/D) : en zone C, l\'habitat neuf peut être limité.');

  /* Mixité sociale publiée par le PLU (seuil/taux détectés à la collecte). */
  const sps = d.prescriptions.find((p) => /mixit[ée].*social|programme de logements|logements sociaux/i.test(libP(p)));
  if (sps) {
    if (d.sps_detecte) {
      push('info', 'SPS', `Mixité sociale imposée : ${Math.round(d.sps_detecte.taux * 100)} % de logement social au-delà de ${num(d.sps_detecte.seuil)} m² de SDP. Appliquée automatiquement au bilan si le seuil est franchi.`, '');
    } else {
      push('vigilance', 'SPS', 'Secteur à programme de logements (mixité sociale) — un pourcentage de logement social s\'impose au-delà d\'un seuil de SDP.', 'Relever le seuil et le taux sur la fiche de zonage.');
    }
  }

  const abf = d.servitudes.filter((s) => /AC1|AC2|AC4|monument|patrimoine|site/i.test(s.categorie || s.libelle || ''));
  if (abf.length) push('majeur', 'ABF', 'Périmètre de protection patrimoniale — avis conforme de l\'ABF.', 'Prendre l\'attache de l\'UDAP avant d\'engager des frais.');

  const r = d.risques || {};
  if (r.inondation_forte) push('bloquant', 'PPRI_ROUGE', 'Aléa inondation fort — probable zone inconstructible.', 'Lire le règlement du PPRI : la zone rouge est bloquante, la zone bleue est aménageable.');
  else if (r.inondation) push('vigilance', 'PPRI', 'Zone inondable — constructible sous prescriptions.', 'Surcoût probable : vide sanitaire, niveau de plancher, pas de sous-sol.');

  if (r.argile >= 3) push('vigilance', 'ARGILE', 'Aléa retrait-gonflement des argiles fort.', 'Étude géotechnique obligatoire. Surcoût de fondations à provisionner.');
  if (r.pprt) push('majeur', 'PPRT', 'PPRT — risque technologique.', 'Vérifier le zonage réglementaire du PPRT.');

  if (d.pollution_sites?.length)
    push('vigilance', 'POLLUTION', `${d.pollution_sites.length} ancien(s) site(s) industriel(s) à proximité.`, 'Diagnostic de pollution à budgéter. Une dépollution peut chiffrer en centaines de k€.');

  const s = connue(d.surface_m2) ? d.surface_m2.val : null;
  if (s !== null && s < 250)
    push('bloquant', 'TROP_PETIT', `Unité foncière de ${num(s)} m² — trop exiguë pour du collectif.`, '');

  if (connue(d.pente_pct) && d.pente_pct.val > 20)
    push('vigilance', 'PENTE', `Pente de ${num(d.pente_pct.val)} % — terrassements importants.`, 'Surcoût de VRD et de fondations.');

  return K;
};

/* ═══ ÉTAPE 4 — ENVELOPPE CONSTRUCTIBLE ═══
   Enveloppe de capacité, pas projet d'architecte. */
const calculerEnveloppe = (d, regles, jeu, tirage = null) => {
  const g = (k) => (tirage ? tirage[k] : jeu[k].v);
  const surfTotale = connue(d.surface_m2) ? d.surface_m2.val : null;
  if (!surfTotale) return null;
  // Multi-zone : le logement ne se calcule que sur la portion résidentielle.
  const partResid = d.repartition ? d.repartition.part_residentielle : 1;
  const surf = surfTotale * partResid;
  if (surf <= 0) return null;

  const anneau = anneauExt(d.geometrie);
  const pts = anneau ? toXY(anneau) : null;

  const rv = tirage?.regles?.recul_voie ?? (connue(regles.recul_voie_m) ? regles.recul_voie_m.val : 0);
  const rl = tirage?.regles?.recul_limites ?? (connue(regles.recul_limites_sep_m) ? regles.recul_limites_sep_m.val : 0);
  const recul = Math.max(rv, rl);

  // Emprise géométriquement disponible après reculs
  // (érosion sur la parcelle entière, ramenée à la part résidentielle en multi-zone)
  let emp_geo = surf;
  if (pts && recul > 0) {
    const r = eroder(pts, recul);
    emp_geo = (r.aire ?? surfTotale * Math.max(0.1, 1 - recul / 12)) * partResid;
  } else if (recul > 0) {
    emp_geo = surf * Math.max(0.1, 1 - recul / 12);
  }

  // Contrainte d'emprise au sol réglementaire
  const ces = tirage?.regles?.emprise ?? (connue(regles.emprise_au_sol_max) ? regles.emprise_au_sol_max.val : null);
  const emp_regl = ces !== null ? surf * ces : surf;

  // Contrainte de pleine terre
  const pt = tirage?.regles?.pleine_terre ?? (connue(regles.pleine_terre_min) ? regles.pleine_terre_min.val : null);
  const emp_pt = pt !== null ? surf * (1 - pt) : surf;

  // Bande de constructibilité (Toulouse) : borne la profondeur bâtie.
  // Approximation : emprise ≤ largeur de façade × profondeur de bande.
  let emp_bande = Infinity;
  if (regles.bande_constructible_m && pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const largeur = Math.max(...xs) - Math.min(...xs);
    const profondeur = Math.max(...ys) - Math.min(...ys);
    const facade = Math.min(largeur, profondeur); // hypothèse prudente : la plus petite dimension donne sur voie
    emp_bande = facade * regles.bande_constructible_m * partResid;
  }

  const emprise = Math.min(emp_geo, emp_regl, emp_pt, emp_bande);

  // Niveaux
  const hm = tirage?.regles?.hauteur ?? (connue(regles.hauteur_max_m) ? regles.hauteur_max_m.val : null);
  const nvx_reg = connue(regles.hauteur_max_niveaux) ? regles.hauteur_max_niveaux.val : null;
  const H_NIVEAU = 3.0;
  let niveaux = nvx_reg ?? (hm ? Math.floor(hm / H_NIVEAU) : null);
  if (niveaux === null) niveaux = 3;
  niveaux = Math.max(1, Math.min(niveaux, 12));

  let sdp = emprise * niveaux * 0.92; // circulations, gaines

  // Densité plafond
  const dens = connue(regles.densite_max_sdp_m2_par_m2) ? regles.densite_max_sdp_m2_par_m2.val : null;
  if (dens !== null) sdp = Math.min(sdp, surf * dens);

  const shab = sdp * g('part_sdp_shab');
  let logts = Math.floor(shab / g('surface_moy_logt'));

  // Stationnement — si aérien, il mange l'emprise. Itération simple.
  const pl = connue(regles.stationnement_par_logt) ? regles.stationnement_par_logt.val : 1;
  const places = Math.ceil(logts * pl);

  /* Mixité sociale : règle saisie > détectée sur le terrain > rien.
     Le taux s'applique dès que la SDP franchit le seuil. */
  let mix = connue(regles.mixite_sociale) ? regles.mixite_sociale.val : 0;
  let mix_auto = false;
  if (!mix) {
    const seuil = d.sps_detecte?.seuil ?? g('sps_seuil_m2');
    const taux = d.sps_detecte?.taux ?? g('sps_taux');
    if (d.sps_detecte && sdp > seuil) { mix = taux; mix_auto = true; }
  }
  const logts_sociaux = Math.round(logts * mix);

  // Décomposition par typologie (mix standard, éditable via hypothèses)
  const mixTypo = { T2: 0.35, T3: 0.40, T4: 0.25 };  // répartition par défaut
  const surfTypo = { T2: 45, T3: 65, T4: 85 };        // m² SHAB indicatifs
  const typologies = Object.keys(mixTypo).map((t) => ({
    type: t,
    nb: Math.round(logts * mixTypo[t]),
    surface: surfTypo[t],
  }));

  return {
    surface_parcelle: surfTotale,
    surface_residentielle: Math.round(surf),
    part_residentielle: partResid,
    mix_social_applique: mix,
    mix_auto,
    emprise: Math.round(emprise),
    emprise_ratio: emprise / surf,
    niveaux,
    sdp: Math.round(sdp),
    shab: Math.round(shab),
    logts,
    logts_sociaux,
    logts_libres: logts - logts_sociaux,
    typologies,
    places,
    recul_applique: recul,
    contrainte_active:
      emprise === emp_bande && isFinite(emp_bande) ? 'Bande de constructibilité (15,5 m)' :
      emprise === emp_geo && recul > 0 ? 'Reculs (géométrie)' :
      emprise === emp_regl && ces !== null ? 'Emprise au sol' :
      emprise === emp_pt && pt !== null ? 'Pleine terre' : 'Aucune',
  };
};

/* ═══ ÉTAPE 5 — BILAN PROMOTEUR INVERSÉ ═══
   La seule question : combien puis-je payer ce terrain ? */
const bilan = (env, d, jeu, tirage = null) => {
  const g = (k) => (tirage ? tirage[k] : jeu[k].v);
  if (!env || env.sdp <= 0) return null;

  const shab_libre = env.logts_libres * g('surface_moy_logt');
  const shab_social = env.logts_sociaux * g('surface_moy_logt');
  // Prix de vente : priorité = surcharge manuelle du terrain > DVF fiable > hypothèse.
  // Sous Monte-Carlo, le tirage a déjà intégré cette priorité (voir monteCarlo).
  const dvfOk = d.prix_m2_dvf?.fiable === true;
  const pv = tirage ? g('prix_vente_m2') : (d.prix_vente_force || (dvfOk ? d.prix_m2_dvf.median : g('prix_vente_m2')));

  const ca_libre = shab_libre * pv;
  const ca_social = shab_social * pv * (1 - g('decote_social'));
  const ca_parking = env.places * g('prix_parking');
  const CA = ca_libre + ca_social + ca_parking;

  const travaux = env.sdp * g('cout_travaux_m2');
  const parkings = env.places * g('cout_parking');
  const demo = (connue(d.bati_existant_m2) ? d.bati_existant_m2.val : 0) * g('cout_demolition_m2');
  const vrd = g('vrd_forfait');
  const travaux_tot = travaux + parkings + demo + vrd;

  const moe = travaux_tot * g('honoraires_moe');
  const assur = travaux_tot * g('assurances');
  const aleas = travaux_tot * g('alea');
  const promo = CA * g('honoraires_promo');
  const commerc = CA * g('commercialisation');
  const finan = CA * g('frais_financiers');
  const ta = env.sdp * g('taxe_amenagement_m2') * g('taux_ta');

  const couts = travaux_tot + moe + assur + aleas + promo + commerc + finan + ta;
  const marge = CA * g('marge_cible');

  // Charge foncière = ce qui reste, net des frais d'acquisition
  const dispo = CA - couts - marge;
  const cf = dispo / (1 + g('frais_acquisition'));
  const ratio_cf_ca = CA > 0 ? cf / CA : 0;

  return {
    CA, ca_libre, ca_social, ca_parking,
    travaux, parkings, demo, vrd, travaux_tot,
    moe, assur, aleas, promo, commerc, finan, ta,
    couts, marge, charge_fonciere: cf,
    cf_m2_sdp: env.sdp ? cf / env.sdp : 0,
    cf_m2_terrain: env.surface_parcelle ? cf / env.surface_parcelle : 0,
    ratio_cf_ca,
    // Garde-fou : en promotion, la charge foncière pèse usuellement 10-25 % du CA.
    coherence: ratio_cf_ca > 0.32 ? 'haute' : ratio_cf_ca < 0 ? 'negative' : 'ok',
  };
};

/* ═══ SCÉNARIOS — trois stratégies chiffrées côte à côte ═══
   On ne recommande rien : on montre les trois bilans avec leurs incertitudes,
   et l'utilisateur décide. Chaque scénario expose ses hypothèses clés. */
const scenarios = (env, d, jeu, mc) => {
  if (!env || env.sdp <= 0) return null;
  const dvfOk = d.prix_m2_dvf?.fiable === true;
  const pv = d.prix_vente_force || (dvfOk ? d.prix_m2_dvf.median : jeu.prix_vente_m2.v);
  const shab = env.shab;

  /* — Scénario 1 : PROMOUVOIR (construire puis vendre) — */
  const b = bilan(env, d, jeu);
  const promouvoir = b ? {
    titre: 'Construire et vendre',
    metrique: 'Prix du terrain admissible (charge foncière)',
    valeur: b.charge_fonciere,
    fourchette: mc ? [mc.p10, mc.p90] : null,
    detail: `${env.logts} logements · CA ${eur(b.CA)} · marge cible ${pct(jeu.marge_cible.v)}`,
    note: 'Métier de promoteur : capital important, risque commercial, horizon 3-5 ans.',
  } : null;

  /* — Scénario 2 : CONSTRUIRE ET LOUER —
     Loyer estimé depuis le prix de vente via un taux de rendement de marché
     (hypothèse affichée), à défaut de données de loyers open data fiables. */
  const rdt_marche = 0.045;
  const loyer_m2_mois = (pv * rdt_marche) / 12;
  const loyers_an = shab * loyer_m2_mois * 12;
  const cout_construction = b ? b.couts : env.sdp * jeu.cout_travaux_m2.v * 1.35;
  const prixT = d.prix_demande || (b ? Math.max(0, b.charge_fonciere) : 0);
  const cout_total_louer = prixT + cout_construction;
  const rdt_brut = cout_total_louer > 0 ? loyers_an / cout_total_louer : 0;
  const louer = {
    titre: 'Construire et louer',
    metrique: 'Rendement brut estimé',
    valeur_pct: rdt_brut,
    detail: `${eur(loyers_an)} de loyers/an estimés (${num(loyer_m2_mois, 1)} €/m²/mois) sur ${eur(cout_total_louer)} investis`,
    note: `Loyer déduit du prix de vente au taux de ${pct(rdt_marche, 1)} (hypothèse de marché). Hors fiscalité, vacance et gestion — le net est sensiblement inférieur.`,
    incertain: !d.prix_demande,
  };

  /* — Scénario 3 : REVENDRE NU — */
  const revendre = {
    titre: 'Revendre le terrain nu',
    metrique: 'Valeur pour un promoteur',
    valeur: mc ? mc.median : (b ? b.charge_fonciere : 0),
    fourchette: mc ? [mc.p10, mc.p90] : null,
    detail: d.prix_demande
      ? `Prix affiché ${eur(d.prix_demande)} → écart ${eur((mc ? mc.median : 0) - d.prix_demande)}`
      : 'Renseignez le prix demandé pour mesurer l\'écart.',
    note: 'La valeur d\'un terrain constructible ≈ sa charge foncière admissible. Un écart positif signale un terrain sous-coté — ou une contrainte que le vendeur connaît et pas vous.',
  };

  return { promouvoir, louer, revendre, hypothese_rdt: rdt_marche };
};

/* ═══ ÉTAPE 6 — MONTE-CARLO ═══
   Les hypothèses sont des distributions. Le point unique est un mensonge. */
const triangulaire = (lo, mode, hi) => {
  if (hi <= lo) return mode;
  const u = Math.random();
  const c = (mode - lo) / (hi - lo);
  return u < c
    ? lo + Math.sqrt(u * (hi - lo) * (mode - lo))
    : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
};

const monteCarlo = (d, regles, jeu, N = 1500) => {
  const res = [];
  const cles = Object.keys(jeu);

  for (let i = 0; i < N; i++) {
    const t = {};
    cles.forEach((k) => {
      const h = jeu[k];
      t[k] = triangulaire(h.p10 ?? h.v * 0.85, h.v, h.p90 ?? h.v * 1.15);
    });
    // Prix de vente : surcharge manuelle (fixe, pas de fourchette) > DVF fiable > hypothèse.
    if (d.prix_vente_force) {
      t.prix_vente_m2 = d.prix_vente_force;
    } else if (d.prix_m2_dvf?.fiable === true) {
      t.prix_vente_m2 = triangulaire(d.prix_m2_dvf.p25, d.prix_m2_dvf.median, d.prix_m2_dvf.p75);
    }
    // Les règles PLU incertaines sont elles aussi tirées
    t.regles = {};
    [['hauteur', regles.hauteur_max_m], ['emprise', regles.emprise_au_sol_max],
     ['recul_voie', regles.recul_voie_m], ['recul_limites', regles.recul_limites_sep_m],
     ['pleine_terre', regles.pleine_terre_min]].forEach(([k, v]) => {
      if (connue(v)) {
        const [lo, m, hi] = bornes(v);
        t.regles[k] = triangulaire(lo, m, hi);
      }
    });

    const env = calculerEnveloppe(d, regles, jeu, t);
    const b = env ? bilan(env, d, jeu, t) : null;
    if (b) res.push({ cf: b.charge_fonciere, sdp: env.sdp, logts: env.logts, ca: b.CA, couts: b.couts });
  }

  if (!res.length) return null;
  const cfs = res.map((r) => r.cf).sort((a, b) => a - b);
  const q = (p) => cfs[Math.min(cfs.length - 1, Math.floor(p * cfs.length))];

  return {
    n: res.length,
    p10: q(0.10), p25: q(0.25), median: q(0.50), p75: q(0.75), p90: q(0.90),
    moy: cfs.reduce((s, x) => s + x, 0) / cfs.length,
    min: cfs[0], max: cfs[cfs.length - 1],
    p_positive: cfs.filter((x) => x > 0).length / cfs.length,
    sdp_med: res.map((r) => r.sdp).sort((a, b) => a - b)[Math.floor(res.length / 2)],
    logts_med: res.map((r) => r.logts).sort((a, b) => a - b)[Math.floor(res.length / 2)],
    echantillon: cfs,
  };
};

/* ═══ ÉTAPE 7 — VERDICT ═══
   Asymétrie assumée. Le doute profite au terrain. */
const rendreVerdict = (killers, mc, prixDemande, regles) => {
  const bloquants = killers.filter((k) => k.sev === 'bloquant');
  if (bloquants.length)
    return { v: 'mort', label: 'Écarté', raison: bloquants[0].msg, detail: bloquants.map((b) => b.code) };

  if (!mc)
    return { v: 'inconnu', label: 'Données insuffisantes', raison: 'Impossible de calculer une capacité. Ce n\'est pas un refus — c\'est un manque.', detail: [] };

  if (mc.p90 <= 0)
    return { v: 'mort', label: 'Écarté', raison: 'Charge foncière négative même dans le scénario le plus favorable.', detail: [] };

  const maj = killers.filter((k) => k.sev === 'majeur');

  if (prixDemande != null && prixDemande > 0) {
    if (mc.p90 < prixDemande * 0.85)
      return { v: 'mort', label: 'Écarté', raison: `Prix demandé (${eur(prixDemande)}) hors d'atteinte même au P90 (${eur(mc.p90)}).`, detail: [] };
    if (mc.median < prixDemande && mc.p90 >= prixDemande)
      return { v: 'marginal', label: 'À négocier', raison: `Passe seulement dans les scénarios hauts. Il faudrait négocier autour de ${eur(mc.median)}.`, detail: maj.map((m) => m.code) };
    if (mc.p25 >= prixDemande)
      return { v: 'creuser', label: 'À creuser', raison: `Marge confortable : la charge admissible dépasse le prix demandé dans 75 % des scénarios.`, detail: maj.map((m) => m.code) };
    return { v: 'creuser', label: 'À creuser', raison: 'Passe dans le scénario médian.', detail: maj.map((m) => m.code) };
  }

  if (maj.length >= 2)
    return { v: 'marginal', label: 'Sous réserve', raison: `${maj.length} contraintes majeures à lever avant d'aller plus loin.`, detail: maj.map((m) => m.code) };

  const conf = regles ? confianceRegles(regles) : 0;
  if (conf < 0.4)
    return { v: 'marginal', label: 'À instruire', raison: 'Règles d\'urbanisme trop incomplètes pour trancher. Le potentiel existe mais n\'est pas mesurable en l\'état.', detail: [] };

  return { v: 'creuser', label: 'À creuser', raison: `Prix du terrain admissible (médiane) : ${eur(mc.median)}.`, detail: maj.map((m) => m.code) };
};

const champsRegles = (r) => Object.entries(r).filter(([, v]) => v && typeof v === 'object' && 'val' in v);
const completude = (r) => {
  const c = champsRegles(r);
  return c.length ? c.filter(([, v]) => connue(v)).length / c.length : 0;
};
const confianceRegles = (r) => {
  const c = champsRegles(r).filter(([, v]) => connue(v));
  return c.length ? c.reduce((s, [, v]) => s + v.conf, 0) / c.length : 0;
};

const REGLES_VIDE = () => ({
  zone: '', libelle_zone: '',
  hauteur_max_m: V(null, { unite: 'm' }),
  hauteur_max_niveaux: V(null, { unite: 'niv' }),
  emprise_au_sol_max: V(null, { unite: 'ratio' }),
  recul_voie_m: V(null, { unite: 'm' }),
  recul_limites_sep_m: V(null, { unite: 'm' }),
  pleine_terre_min: V(null, { unite: 'ratio' }),
  stationnement_par_logt: V(null, { unite: 'pl/logt' }),
  mixite_sociale: V(null, { unite: 'ratio' }),
  densite_max_sdp_m2_par_m2: V(null, { unite: 'm²/m²' }),
  bande_constructible_m: null,     // Toulouse : bande de 15,5 m depuis la voie
  source_type: 'texte',            // 'texte' (LLM) | 'etiquette' (graphique)
  ambiguites: [],
});

const LIB_REGLES = {
  hauteur_max_m: 'Hauteur maximale',
  hauteur_max_niveaux: 'Nombre de niveaux',
  emprise_au_sol_max: 'Emprise au sol',
  recul_voie_m: 'Recul sur voie',
  recul_limites_sep_m: 'Recul sur limites séparatives',
  pleine_terre_min: 'Pleine terre minimale',
  stationnement_par_logt: 'Stationnement par logement',
  mixite_sociale: 'Mixité sociale',
  densite_max_sdp_m2_par_m2: 'Densité maximale',
};

/* ══════════════════════════════════════════════════════════════════════════
   PLU À ÉTIQUETTES (Toulouse Métropole et PLUi modernisés)
   Les valeurs hauteur/emprise/pleine-terre ne sont PAS dans le texte.
   Elles sont sur une étiquette graphique attachée à la parcelle :
       UM3  15  L  50  25   →  zone / HF / HV / CES / CEPT
   Codes spéciaux : NR = non réglementé · RE = régi par le règlement écrit.
   ══════════════════════════════════════════════════════════════════════════ */

/* Zones du PLUi-H de Toulouse → l'app bascule en mode étiquette. */
const RE_ZONE_ETIQUETTE = /^(UM|UA|UIC|UP|AUM|AUA|AUIC|AUP)\d/i;

const estPluEtiquette = (zonage) => RE_ZONE_ETIQUETTE.test(zonage || '');

/* Parse une étiquette saisie ou lue : "UM3 15 L 50 25" ou "15 L 50% 25%". */
const parserEtiquette = (txt) => {
  if (!txt) return null;
  const brut = txt.trim().replace(/%/g, '').replace(/\s+/g, ' ');
  const toks = brut.split(' ');
  // On retire un éventuel code de zone en tête (UM3, UAa…)
  if (toks[0] && /^[A-Za-z]/.test(toks[0]) && !/^(NR|RE|L)$/i.test(toks[0])) toks.shift();

  const lire = (t) => {
    if (t == null) return { code: 'ABSENT' };
    const T = t.toUpperCase();
    if (T === 'NR') return { code: 'NR' };       // non réglementé
    if (T === 'RE') return { code: 'RE' };       // renvoi règlement écrit
    if (T === 'L')  return { code: 'L' };        // hauteur fonction de la voie
    const n = parseFloat(t.replace(',', '.'));
    return isNaN(n) ? { code: 'ABSENT' } : { code: 'VAL', v: n };
  };

  // Ordre officiel de l'étiquette : HF, HV, CES, CEPT
  return { hf: lire(toks[0]), hv: lire(toks[1]), ces: lire(toks[2]), cept: lire(toks[3]), brut };
};

/* Convertit une étiquette parsée en règles TERRA (avec la bonne fiabilité). */
const etiquetteVersRegles = (et, zone) => {
  const R = REGLES_VIDE();
  R.zone = zone || '';
  R.source_type = 'etiquette';
  const amb = [];

  // HF → hauteur façade (m)
  if (et.hf.code === 'VAL')
    R.hauteur_max_m = V(et.hf.v, { unite: 'm', fiab: F.API, conf: 0.9, source: 'Étiquette PLUi-H (HF)', citation: `HF ${et.hf.v} m sur l'étiquette` });
  else if (et.hf.code === 'RE')
    amb.push({ regle: 'hauteur_max_m', probleme: 'Hauteur régie par le règlement écrit (RE) — pas une valeur simple.', impact: 'Lire les dispositions spécifiques de la zone.' });
  else if (et.hf.code === 'NR')
    R.hauteur_max_m = V(null, { unite: 'm', fiab: F.ABSENT, note: 'Non réglementé (NR) — dispositions communes applicables.' });

  // HV → hauteur sur voie
  if (et.hv.code === 'L')
    amb.push({ regle: 'hauteur_max_m', probleme: 'Hauteur sur voie = L : fonction de la largeur de la voie, non résolue automatiquement.', impact: 'La hauteur réelle bordant la voie dépend de la largeur de rue.' });

  // CES → emprise au sol (le chiffre d'étiquette est en %, on stocke en ratio)
  if (et.ces.code === 'VAL')
    R.emprise_au_sol_max = V(et.ces.v > 1 ? et.ces.v / 100 : et.ces.v, { unite: 'ratio', fiab: F.API, conf: 0.9, source: 'Étiquette PLUi-H (CES)', citation: `CES ${et.ces.v} %` });
  else if (et.ces.code === 'RE')
    amb.push({ regle: 'emprise_au_sol_max', probleme: 'Emprise au sol régie par le règlement écrit (RE).', impact: '' });

  // CEPT → pleine terre minimale
  if (et.cept.code === 'VAL')
    R.pleine_terre_min = V(et.cept.v > 1 ? et.cept.v / 100 : et.cept.v, { unite: 'ratio', fiab: F.API, conf: 0.9, source: 'Étiquette PLUi-H (CEPT)', citation: `CEPT ${et.cept.v} %` });

  // Bande de constructibilité de 15,5 m : dispositions communes Toulouse.
  // Elle borne l'emprise indépendamment du CES → on la pose comme note.
  R.bande_constructible_m = 15.5;

  R.ambiguites = amb;
  return R;
};

/* Requête GPU multi-couches : on tente de lire l'étiquette automatiquement.
   Si Toulouse a publié hauteur/CES/CEPT en attributs, on les récupère ;
   sinon on renvoie null et l'app passe en saisie assistée. */
async function lireEtiquetteAuto(geomParam) {
  if (!geomParam) return null;
  // Couches candidates connues du standard CNIG / PLUi.
  // secteur-cc et zone-urba portent parfois des attributs de hauteur.
  const candidats = [
    'https://apicarto.ign.fr/api/gpu/zone-urba',
    'https://apicarto.ign.fr/api/gpu/secteur-cc',
  ];
  for (const url of candidats) {
    try {
      const r = await jget(`${url}?geom=${geomParam}`);
      const p = r.features?.[0]?.properties || {};
      // On cherche tout attribut ressemblant à hauteur / emprise / pleine terre
      const cherche = (regex) => {
        const k = Object.keys(p).find((x) => regex.test(x) && p[x] != null && p[x] !== '');
        return k ? p[k] : null;
      };
      const hf = cherche(/haut|^hf$|hmax/i);
      const ces = cherche(/emprise|^ces$|coef.*sol/i);
      const cept = cherche(/pleine.*terre|^cept$/i);
      if (hf || ces || cept) {
        return { hf: hf ? String(hf) : '', ces: ces ? String(ces) : '', cept: cept ? String(cept) : '', auto: true };
      }
    } catch { /* on tente la couche suivante */ }
  }
  return null; // aucune donnée structurée → saisie manuelle
}

/* ══════════════════════════════════════════════════════════════════════════
   EXTRACTION PLU — le seul endroit où l'IA a sa place.
   Citation obligatoire. Score de confiance. Ambiguïtés déclarées.
   ══════════════════════════════════════════════════════════════════════════ */
const PROMPT_PLU = `Tu extrais les règles de constructibilité d'un règlement de PLU français.

RÈGLES ABSOLUES :
1. Tu ne renvoies QUE ce que le texte dit. Si une règle n'est pas mentionnée, tu mets null. Ne devine JAMAIS.
2. Chaque valeur extraite est accompagnée d'une citation VERBATIM du texte (30 mots max) et d'une confiance entre 0 et 1.
3. Si le texte est ambigu (ex. hauteur "au terrain naturel" sans définir le point de mesure), tu mets la lecture la plus PRUDENTE, une confiance BASSE, et tu décris l'ambiguïté.
4. Une confiance de 1 signifie : le texte donne un chiffre explicite, sans condition ni exception. C'est rare.

Réponds UNIQUEMENT en JSON, sans backticks, sans préambule :
{
  "zone": "code de la zone (ex: UB, UAa)",
  "libelle_zone": "intitulé si présent",
  "destination_habitat_autorisee": true|false|null,
  "regles": {
    "hauteur_max_m":              {"val": nombre|null, "conf": 0-1, "citation": "...", "note": "ambiguïté éventuelle"},
    "hauteur_max_niveaux":        {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "emprise_au_sol_max":         {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "recul_voie_m":               {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "recul_limites_sep_m":        {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "pleine_terre_min":           {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "stationnement_par_logt":     {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""},
    "mixite_sociale":             {"val": 0-1|null,    "conf": 0-1, "citation": "...", "note": ""},
    "densite_max_sdp_m2_par_m2":  {"val": nombre|null, "conf": 0-1, "citation": "...", "note": ""}
  },
  "ambiguites": [
    {"regle": "hauteur_max_m", "probleme": "description courte", "impact": "conséquence chiffrée si estimable"}
  ]
}

Les ratios (emprise, pleine terre, mixité) sont en DÉCIMAL : 40 % → 0.4.
Si une règle dépend d'une condition que tu ne peux pas trancher, confiance ≤ 0.5 et note explicite.`;

async function extrairePLU(texte, zone) {
  const r = await fetch('/api/plu', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texte: texte.slice(0, 45000), zone }),
  });
  if (!r.ok) throw new Error(`extraction HTTP ${r.status}`);
  const txt = await r.text();
  const clean = txt.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

const jsonVersRegles = (j) => {
  const R = REGLES_VIDE();
  R.zone = j.zone || '';
  R.libelle_zone = j.libelle_zone || '';
  R.destination_habitat_autorisee = j.destination_habitat_autorisee;
  Object.entries(j.regles || {}).forEach(([k, o]) => {
    if (!(k in R)) return;
    R[k] = V(o.val, {
      unite: R[k].unite,
      fiab: o.val == null ? F.ABSENT : F.LLM,
      conf: o.conf ?? 0.5,
      citation: o.citation || '',
      note: o.note || '',
      source: `PLU zone ${j.zone || '?'}`,
    });
  });
  R.ambiguites = j.ambiguites || [];
  return R;
};

/* ══════════════════════════════════════════════════════════════════════════
   COLLECTE — étape 1
   ══════════════════════════════════════════════════════════════════════════ */
const jget = async (url, ms = 15000) => {
  const cible = via(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(cible, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { clearTimeout(t); throw e; }
};

async function collecter(entree, onEtape) {
  await backendDispo(); // sonde le proxy une fois (Git = oui, drag-and-drop = non)
  const d = {
    id: Math.random().toString(36).slice(2, 9),
    ref: entree.ref || '', code_insee: entree.insee || '', commune: '', adresse: entree.adresse || '',
    geometrie: null, parcelles: [],
    surface_m2: V(null, { unite: 'm²' }),
    zonage: '', zonage_absent_connu: false, zonages_multiples: [],
    prescriptions: [], servitudes: [], risques: {}, pollution_sites: [],
    pente_pct: V(null, { unite: '%' }),
    bati_existant_m2: V(null, { unite: 'm²' }),
    prix_demande: entree.prix ?? null,
    sources_ko: [], alertes: [],
    horodatage: new Date().toISOString(),
  };

  /* Géocodage */
  if (entree.adresse && !entree.insee) {
    onEtape?.('Géocodage de l\'adresse');
    try {
      const g = await jget(`${API.adresse}/?q=${encodeURIComponent(entree.adresse)}&limit=1`);
      const f = g.features?.[0];
      if (f) {
        d.code_insee = f.properties.citycode;
        d.commune = f.properties.city;
        d.lon = f.geometry.coordinates[0];
        d.lat = f.geometry.coordinates[1];
        d.adresse = f.properties.label;
      }
    } catch { d.sources_ko.push('Géocodage'); }
  }

  /* Cadastre */
  onEtape?.('Récupération de la parcelle');
  try {
    const p = new URLSearchParams();
    if (d.code_insee) p.set('code_insee', d.code_insee);
    if (entree.section) p.set('section', entree.section);
    if (entree.numero) p.set('numero', entree.numero);
    if (d.lon && d.lat && !entree.section)
      p.set('geom', JSON.stringify({ type: 'Point', coordinates: [d.lon, d.lat] }));
    p.set('source_ign', 'PCI');

    const c = await jget(`${API.cadastre}?${p}`);
    const f = c.features?.[0];
    if (f) {
      d.geometrie = f.geometry;
      d.parcelles = c.features.map((x) => `${x.properties.section}${x.properties.numero}`);
      d.ref = `${f.properties.section}${f.properties.numero}`;
      d.commune = d.commune || f.properties.nom_com || '';
      // Section au format Etalab DVF : 5 caractères, complété à gauche par des zéros.
      // Ex. section "BC" → "000BC" ; parfois préfixe commune sur 2 chiffres.
      const sec = (f.properties.section || '').toUpperCase();
      if (sec) d.section_dvf = sec.padStart(5, '0');
      const s = f.properties.contenance || surfaceGeom(f.geometry);
      if (s) d.surface_m2 = V(Math.round(s), { unite: 'm²', fiab: F.API, conf: 0.95, source: 'Cadastre PCI (IGN)' });
    } else {
      d.sources_ko.push('Cadastre — aucune parcelle');
    }
  } catch { d.sources_ko.push('Cadastre'); }

  const geomParam = d.geometrie ? encodeURIComponent(JSON.stringify(d.geometrie)) : null;

  /* Zonage PLU */
  if (geomParam) {
    onEtape?.('Zonage du document d\'urbanisme');
    try {
      const z = await jget(`${API.gpuZone}?geom=${geomParam}`);
      const feats = (z.features || []).filter((f) => f.properties.libelle);
      const zs = feats.map((f) => f.properties.libelle);
      if (zs.length) {
        d.zonage = zs[0];
        d.zonages_multiples = [...new Set(zs)];
        if (d.zonages_multiples.length > 1) {
          // Répartition géométrique des surfaces entre zones
          const zonesFeats = feats.map((f) => ({ libelle: f.properties.libelle, geometry: f.geometry }));
          const surfT = connue(d.surface_m2) ? d.surface_m2.val : null;
          d.repartition = repartirZones(d.geometrie, zonesFeats, surfT);
          d.alertes.push({ sev: 'vigilance', code: 'ZONE_MULTI', msg: `Parcelle à cheval sur ${d.zonages_multiples.length} zones : ${d.zonages_multiples.join(', ')}.`, action: 'Le potentiel logement est calculé sur la seule portion résidentielle.' });
          // La zone de référence pour l'étiquette devient la zone résidentielle dominante
          const resid = d.repartition?.repartition?.find((r) => !r.activites);
          if (resid) d.zonage = resid.zone;
        }
        // NB : on ne stocke JAMAIS les géométries des zones (souvent des milliers
        // de points) — elles feraient exploser le localStorage à la sauvegarde.
      } else {
        // Absence de résultat ≠ absence de document. La doc GPU le dit explicitement.
        try {
          const m = await jget(`${API.gpuMuni}?insee=${d.code_insee}`);
          const rnu = m.features?.[0]?.properties?.is_rnu;
          if (rnu === true) { d.zonage_absent_connu = true; d.zonage = 'RNU'; }
        } catch { /* rien */ }
      }
    } catch { d.sources_ko.push('Zonage GPU'); }

    /* Prescriptions */
    onEtape?.('Prescriptions (ER, EBC, OAP)');
    try {
      const p = await jget(`${API.gpuPresc}?geom=${geomParam}`);
      d.prescriptions = (p.features || []).map((f) => ({
        libelle: f.properties.libelle || '',
        typepsc: f.properties.typepsc || '',
        nomfic: f.properties.nomfic || '',
      }));
      // Détection du seuil/taux de mixité sociale s'il est publié, ex "( 1000 / 40)"
      for (const pr of d.prescriptions) {
        const t = `${pr.libelle} ${pr.typepsc}`;
        if (/mixit[ée].*social|programme de logements|logements sociaux/i.test(t)) {
          const m = t.match(/(\d{3,5})\s*\/\s*(\d{1,2})/);
          if (m) { d.sps_detecte = { seuil: +m[1], taux: +m[2] / 100 }; break; }
        }
      }
    } catch { d.sources_ko.push('Prescriptions GPU'); }

    /* Servitudes */
    onEtape?.('Servitudes d\'utilité publique');
    try {
      const s = await jget(`${API.gpuSup}?geom=${geomParam}`);
      d.servitudes = (s.features || []).map((f) => ({
        categorie: f.properties.categorie || '',
        libelle: f.properties.libelle || f.properties.nomsuplitt || '',
      }));
    } catch { d.sources_ko.push('Servitudes GPU'); }
  }

  /* Risques */
  if (d.lat && d.lon) {
    onEtape?.('Risques naturels et technologiques');
    try {
      const r = await jget(`${API.risques}?latlon=${d.lon},${d.lat}`);
      const inond = r.inondation || {};
      d.risques = {
        inondation: !!(inond.present ?? r.risquesNaturels?.inondation?.present),
        inondation_forte: /fort|élevé|rouge/i.test(JSON.stringify(inond).slice(0, 800)),
        argile: r.argile?.exposition ?? r.risquesNaturels?.argile?.exposition ?? null,
        seisme: r.zonage_sismique?.zone_sismicite ?? null,
        pprt: !!(r.risquesTechnologiques?.pprt?.present),
        radon: r.radon?.classe_potentiel ?? null,
      };
      d.pollution_sites = r.basias || r.basol || [];
    } catch { d.sources_ko.push('Géorisques'); }
  }

  /* Sections cadastrales voisines dans un rayon ~1 km — pour élargir le DVF
     au-delà de la seule section du terrain (utile quand le terrain est atypique
     ou que sa section a peu de ventes résidentielles). */
  let sectionsVoisines = [];
  if (d.lon && d.lat) {
    onEtape?.('Recherche des sections voisines (1 km)');
    try {
      const R_DEG_LAT = 1000 / 111320; // ~1 km en degrés de latitude
      const R_DEG_LON = 1000 / (111320 * Math.cos((d.lat * Math.PI) / 180));
      const M = 16;
      const cercle = Array.from({ length: M }, (_, i) => {
        const a = (i / M) * 2 * Math.PI;
        return [d.lon + R_DEG_LON * Math.cos(a), d.lat + R_DEG_LAT * Math.sin(a)];
      });
      cercle.push(cercle[0]);
      const geomCercle = encodeURIComponent(JSON.stringify({ type: 'Polygon', coordinates: [cercle] }));
      const c = await jget(`${API.cadastre}?geom=${geomCercle}&source_ign=PCI`);
      const secs = new Set();
      (c.features || []).forEach((f) => { if (f.properties.section) secs.add(f.properties.section.toUpperCase()); });
      sectionsVoisines = [...secs].filter((s) => s !== (d.ref ? d.ref.match(/^[A-Z]+/)?.[0] : null)).slice(0, 8);
    } catch { /* recherche non bloquante */ }
  }

  /* Prix de vente réels (DVF Etalab) — mutations de la section propre +
     sections voisines dans ~1 km. API officielle :
     app.dvf.etalab.gouv.fr/api/mutations3/{insee}/{section} */
  if (d.code_insee && d.section_dvf) {
    onEtape?.('Prix de vente réels (DVF, rayon 1 km)');

    const variantesDe = (secBrute) => {
      const sec = secBrute.replace(/^0+/, '');
      return [...new Set([
        secBrute.padStart(5, '0'),
        '0' + sec.padStart(4, '0'),
        sec.padEnd(5, '0'),
        '00' + sec.padEnd(3, '0'),
      ])];
    };

    const chercherSection = async (secBrute) => {
      for (const v of variantesDe(secBrute)) {
        try {
          const dvf = await jget(`https://app.dvf.etalab.gouv.fr/api/mutations3/${d.code_insee}/${v}`);
          const arr = dvf.donnees || dvf.mutations || null;
          if (arr && arr.length) return arr;
        } catch { /* variante suivante */ }
      }
      return [];
    };

    const secPropre = d.ref ? d.ref.match(/^[A-Z]+/)?.[0] : null;
    const toutesSections = [...new Set([secPropre, ...sectionsVoisines].filter(Boolean))];
    const resultats = await Promise.allSettled(toutesSections.map((s) => chercherSection(s)));
    let muts = resultats.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    if (muts.length) {
      /* ── Nettoyage DVF ──
         Piège n°1 : une même mutation apparaît sur PLUSIEURS lignes (une par
         local/parcelle), avec la valeur totale répétée sur chacune. Diviser
         naïvement valeur/surface ligne à ligne produit des €/m² absurdes.
         → On regroupe par id_mutation : 1 vente = valeur unique + somme des
           surfaces bâties de ses lignes. */
      const parMutation = new Map();
      muts.forEach((m) => {
        const id = m.id_mutation || m.idmutation || `${m.date_mutation}|${m.valeur_fonciere}`;
        if (!parMutation.has(id)) {
          parMutation.set(id, {
            valeur: parseFloat(m.valeur_fonciere) || 0,
            surface: 0, types: new Set(), nat: m.nature_mutation || '',
            date: m.date_mutation || '', nb_lignes: 0,
          });
        }
        const mm = parMutation.get(id);
        mm.nb_lignes++;
        const s = parseFloat(m.surface_reelle_bati);
        if (s > 0) mm.surface += s;
        if (m.type_local) mm.types.add(m.type_local);
      });

      const comparables = [];
      for (const [, mm] of parMutation) {
        if (!/Vente/.test(mm.nat)) continue;
        const estHabitat = [...mm.types].some((t) => /Appartement|Maison/.test(t));
        if (!estHabitat) continue;
        // Vente en bloc (immeuble entier, >6 lignes) : marché différent, on écarte.
        if (mm.nb_lignes > 6) continue;
        if (!(mm.valeur > 10000 && mm.surface > 15 && mm.surface < 600)) continue;
        const r = mm.valeur / mm.surface;
        if (r > 500 && r < 25000) {
          comparables.push({ prix_m2: Math.round(r), valeur: Math.round(mm.valeur), surface: Math.round(mm.surface), type: [...mm.types].filter((t) => /Appartement|Maison/.test(t))[0] || '', date: mm.date });
        }
      }

      const echelle = toutesSections.length > 1 ? `${toutesSections.length} sections (~1 km)` : 'section';

      if (comparables.length >= 5) {
        /* Winsorisation : on coupe les 10 % extrêmes des deux côtés avant
           les quantiles — la médiane devient insensible aux lignes cassées. */
        const tri = comparables.map((c) => c.prix_m2).sort((a, b) => a - b);
        const k = Math.floor(tri.length * 0.10);
        const noyau = tri.slice(k, tri.length - k || tri.length);
        const q = (f) => noyau[Math.min(noyau.length - 1, Math.floor(f * noyau.length))];
        const median = Math.round(q(0.5));

        /* Garde-fou de vraisemblance : une donnée automatique n'a JAMAIS le
           droit de rendre le calcul absurde en silence. Hors fourchette
           plausible → indicatif seulement, PAS injecté dans le bilan. */
        const plausible = median >= 1200 && median <= 12000;
        d.prix_m2_dvf = {
          median, p25: Math.round(q(0.25)), p75: Math.round(q(0.75)),
          n: comparables.length, echelle,
          fiable: plausible,
          note: plausible ? '' : 'Médiane hors fourchette plausible — affichée à titre indicatif, non utilisée dans le bilan.',
        };
        d.comparables = comparables.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 12);
      } else if (comparables.length > 0) {
        // Trop peu de ventes pour une médiane robuste : indicatif seulement.
        const moy = Math.round(comparables.reduce((a, c) => a + c.prix_m2, 0) / comparables.length);
        d.prix_m2_dvf = { median: moy, p25: Math.round(moy * 0.85), p75: Math.round(moy * 1.15), n: comparables.length, echelle, fiable: false, note: `Seulement ${comparables.length} vente(s) comparables sur ${echelle} — indicatif, non utilisé dans le bilan.` };
        d.comparables = comparables;
      } else {
        d.sources_ko.push('DVF — aucune vente exploitable dans le rayon');
      }
    } else {
      d.sources_ko.push('DVF');
    }
  }

  onEtape?.(null);
  return d;
}


/* ══════════════════════════════════════════════════════════════════════════
   INTERFACE
   ══════════════════════════════════════════════════════════════════════════ */

const C = {
  fond: '#12161c', panneau: '#181d25', panneau2: '#1e2530', bord: '#2a3342',
  bord2: '#374357', txt: '#e6ebf2', txt2: '#96a3b6', txt3: '#5f6d80',
  ambre: '#e0a341', ambre2: '#8a6320',
  vert: '#4ba87d', rouge: '#d1596a', bleu: '#5a91c4', violet: '#9a7fd1',
};

const VERDICTS = {
  creuser:  { c: C.vert,  bg: 'rgba(75,168,125,.10)',  bd: 'rgba(75,168,125,.35)',  ic: '↗' },
  marginal: { c: C.ambre, bg: 'rgba(224,163,65,.10)',  bd: 'rgba(224,163,65,.35)',  ic: '≈' },
  mort:     { c: C.rouge, bg: 'rgba(209,89,106,.10)',  bd: 'rgba(209,89,106,.35)',  ic: '×' },
  inconnu:  { c: C.txt3,  bg: 'rgba(95,109,128,.10)',  bd: 'rgba(95,109,128,.35)',  ic: '?' },
};

const SEV = {
  bloquant:   { c: C.rouge,  l: 'Bloquant' },
  majeur:     { c: C.ambre,  l: 'Majeur' },
  vigilance:  { c: C.bleu,   l: 'Vigilance' },
  info:       { c: C.txt3,   l: 'Info' },
};

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
#terra{background:${C.fond};color:${C.txt};min-height:100vh;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
#terra .mono{font-family:'JetBrains Mono','SF Mono',Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
#terra button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
#terra input,#terra select,#terra textarea{font-family:inherit;font-size:13px;
  background:${C.fond};border:1px solid ${C.bord};color:${C.txt};
  padding:9px 11px;border-radius:5px;outline:none;width:100%;transition:border-color .12s}
#terra input:focus,#terra select:focus,#terra textarea:focus{border-color:${C.ambre}}
#terra input::placeholder,#terra textarea::placeholder{color:${C.txt3}}
#terra ::-webkit-scrollbar{width:9px;height:9px}
#terra ::-webkit-scrollbar-track{background:${C.fond}}
#terra ::-webkit-scrollbar-thumb{background:${C.bord2};border-radius:5px}
#terra ::-webkit-scrollbar-thumb:hover{background:#485772}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.txt3}}
.pan{background:${C.panneau};border:1px solid ${C.bord};border-radius:8px}
.btn{padding:9px 16px;border-radius:5px;font-size:13px;font-weight:500;
  transition:all .12s;display:inline-flex;align-items:center;gap:7px;justify-content:center}
.btn-p{background:${C.ambre};color:#12161c;font-weight:600}
.btn-p:hover{background:#eeb256}
.btn-p:disabled{opacity:.35;cursor:not-allowed}
.btn-s{background:${C.panneau2};border:1px solid ${C.bord2};color:${C.txt2}}
.btn-s:hover{border-color:${C.ambre};color:${C.txt}}
.btn-g{background:none;color:${C.txt3};padding:6px 10px}
.btn-g:hover{color:${C.txt}}
.tag{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:3px;
  font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.row{display:flex;align-items:center}
.grow{flex:1}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:.7}}
.pulsing{animation:pulse 1.4s ease-in-out infinite}
@keyframes slidein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.slidein{animation:slidein .28s ease-out both}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/* ── Barre de distribution : la signature de l'app ────────────────────────
   On ne montre jamais un chiffre seul. On montre la fourchette,
   et où tombe le prix demandé dedans. */
function Distribution({ mc, prix }) {
  if (!mc) return null;
  const lo = Math.min(mc.p10, prix ?? mc.p10) * 0.9;
  const hi = Math.max(mc.p90, prix ?? mc.p90) * 1.1;
  const span = hi - lo || 1;
  const x = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));

  const zones = [
    { a: mc.p10, b: mc.p25, o: 0.16 },
    { a: mc.p25, b: mc.p75, o: 0.42 },
    { a: mc.p75, b: mc.p90, o: 0.16 },
  ];

  return (
    <div style={{ padding: '26px 0 8px' }}>
      <div style={{ position: 'relative', height: 52 }}>
        <div style={{ position: 'absolute', top: 20, left: 0, right: 0, height: 1, background: C.bord }} />
        {zones.map((z, i) => (
          <div key={i} style={{
            position: 'absolute', top: 10, height: 22,
            left: `${x(z.a)}%`, width: `${x(z.b) - x(z.a)}%`,
            background: C.ambre, opacity: z.o, borderRadius: 2,
          }} />
        ))}
        {/* médiane */}
        <div style={{ position: 'absolute', top: 4, left: `${x(mc.median)}%`, transform: 'translateX(-50%)' }}>
          <div style={{ width: 2, height: 34, background: C.ambre }} />
          <div className="mono" style={{ marginTop: 5, fontSize: 12, fontWeight: 600, color: C.ambre, whiteSpace: 'nowrap', transform: 'translateX(-50%)', marginLeft: 1 }}>
            {eur(mc.median)}
          </div>
        </div>
        {/* prix demandé */}
        {prix != null && prix > 0 && (
          <div style={{ position: 'absolute', top: 0, left: `${x(prix)}%`, transform: 'translateX(-50%)' }}>
            <div style={{ width: 2, height: 42, background: prix <= mc.median ? C.vert : C.rouge, boxShadow: `0 0 8px ${prix <= mc.median ? C.vert : C.rouge}66` }} />
            <div style={{ position: 'absolute', top: -19, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>
              <span className="tag" style={{ background: prix <= mc.median ? 'rgba(75,168,125,.16)' : 'rgba(209,89,106,.16)', color: prix <= mc.median ? C.vert : C.rouge }}>
                demandé {eur(prix)}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="row mono" style={{ justifyContent: 'space-between', fontSize: 10, color: C.txt3, marginTop: 24, paddingTop: 8, borderTop: `1px solid ${C.bord}` }}>
        <span>P10 {eur(mc.p10)}</span>
        <span style={{ color: C.txt2 }}>50 % des scénarios dans la zone dense</span>
        <span>P90 {eur(mc.p90)}</span>
      </div>
    </div>
  );
}

/* ── Ligne de bilan ─────────────────────────────────────────────────────── */
function Ligne({ l, v, fort, neg, indent, formule, provenance }) {
  const [ouvert, setOuvert] = useState(false);
  const cliquable = !!(formule || provenance);
  return (
    <div style={{ borderBottom: fort ? `1px solid ${C.bord}` : 'none', marginTop: fort ? 4 : 0 }}>
      <div className="row" onClick={cliquable ? () => setOuvert((o) => !o) : undefined}
        style={{
          justifyContent: 'space-between', padding: '6px 0', paddingLeft: indent ? 16 : 0,
          cursor: cliquable ? 'pointer' : 'default',
        }}>
        <span className="row" style={{ gap: 5, fontSize: indent ? 12 : 13, color: fort ? C.txt : (indent ? C.txt3 : C.txt2), fontWeight: fort ? 600 : 400 }}>
          {cliquable && <span className="mono" style={{ fontSize: 9, color: C.txt3, width: 8 }}>{ouvert ? '▾' : '▸'}</span>}
          {l}
        </span>
        <span className="mono" style={{ fontSize: indent ? 12 : 13, fontWeight: fort ? 600 : 500, color: neg ? C.rouge : (fort ? C.txt : C.txt2) }}>
          {neg ? '−' : ''}{eur(Math.abs(v))}
        </span>
      </div>
      {ouvert && cliquable && (
        <div className="slidein" style={{ margin: '2px 0 8px', marginLeft: indent ? 16 : 0, padding: '10px 12px', background: C.fond, borderRadius: 5, border: `1px solid ${C.bord}` }}>
          {formule && (
            <div className="mono" style={{ fontSize: 11, color: C.txt2, lineHeight: 1.6, marginBottom: provenance ? 8 : 0 }}>
              {formule}
            </div>
          )}
          {provenance && (
            <div style={{ fontSize: 11, color: C.txt3, lineHeight: 1.5 }}>
              <span style={{ color: C.bleu }}>Source — </span>{provenance}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Champ hypothèse : éditable, traçable, réversible ───────────────────── */
function ChampH({ k, h, onSet, onReset }) {
  const [ed, setEd] = useState(false);
  const [tmp, setTmp] = useState({ v: h.v, p10: h.p10, p90: h.p90 });
  const modifie = h.src === 'utilisateur';
  const ratio = /ratio|×|décote|taux/.test(h.u);
  const aff = (x) => (ratio ? `${(x * 100).toFixed(1).replace('.0', '')} %` : num(x));

  const valider = () => {
    onSet(k, { v: +tmp.v, p10: +tmp.p10, p90: +tmp.p90, src: 'utilisateur', modifie_le: new Date().toISOString() });
    setEd(false);
  };

  if (ed) {
    return (
      <div className="slidein" style={{ padding: 12, background: C.panneau2, border: `1px solid ${C.ambre}`, borderRadius: 6, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{h.lib}</div>
        {h.aide && <div style={{ fontSize: 11, color: C.txt3, marginBottom: 10, lineHeight: 1.4 }}>{h.aide}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7, marginBottom: 9 }}>
          {[['p10', 'Bas'], ['v', 'Probable'], ['p90', 'Haut']].map(([f, lab]) => (
            <div key={f}>
              <div className="eyebrow" style={{ marginBottom: 4, fontSize: 9 }}>{lab}</div>
              <input className="mono" type="number" step="any" value={tmp[f] ?? ''}
                onChange={(e) => setTmp({ ...tmp, [f]: e.target.value })}
                style={{ padding: '6px 8px', fontSize: 12, borderColor: f === 'v' ? C.ambre : C.bord }} />
            </div>
          ))}
        </div>
        <div className="row" style={{ gap: 7 }}>
          <button className="btn btn-p" onClick={valider} style={{ padding: '6px 14px', fontSize: 12 }}>Enregistrer</button>
          <button className="btn btn-g" onClick={() => setEd(false)} style={{ fontSize: 12 }}>Annuler</button>
          <span className="grow" />
          <span className="mono" style={{ fontSize: 10, color: C.txt3 }}>{h.u}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="row" onClick={() => { setTmp({ v: h.v, p10: h.p10 ?? h.v * 0.85, p90: h.p90 ?? h.v * 1.15 }); setEd(true); }}
      style={{
        padding: '9px 11px', borderRadius: 5, marginBottom: 3, cursor: 'pointer',
        background: modifie ? 'rgba(224,163,65,.06)' : 'transparent',
        borderLeft: `2px solid ${modifie ? C.ambre : 'transparent'}`,
        transition: 'background .1s',
      }}
      onMouseEnter={(e) => { if (!modifie) e.currentTarget.style.background = C.panneau2; }}
      onMouseLeave={(e) => { if (!modifie) e.currentTarget.style.background = 'transparent'; }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.txt }}>{h.lib}</div>
        <div className="mono" style={{ fontSize: 10, color: C.txt3, marginTop: 1 }}>
          {aff(h.p10 ?? h.v * 0.85)} — {aff(h.p90 ?? h.v * 1.15)}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
        <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: modifie ? C.ambre : C.txt }}>{aff(h.v)}</div>
        <div className="mono" style={{ fontSize: 9, color: C.txt3 }}>{h.u}</div>
      </div>
      {modifie && (
        <button className="btn-g" onClick={(e) => { e.stopPropagation(); onReset(k); }}
          title="Revenir au preset"
          style={{ marginLeft: 8, fontSize: 14, color: C.txt3, padding: '2px 5px', flexShrink: 0 }}>↺</button>
      )}
    </div>
  );
}

/* ── Règle PLU : chaque valeur porte sa citation et sa confiance ────────── */
function ChampRegle({ k, v, onSet }) {
  const [ed, setEd] = useState(false);
  const [tmp, setTmp] = useState(v.val ?? '');
  const ratio = v.unite === 'ratio';
  const aff = v.val == null ? null : (ratio ? `${(v.val * 100).toFixed(0)} %` : `${num(v.val, v.val % 1 ? 1 : 0)} ${v.unite}`);

  const cConf = !connue(v) ? C.txt3 : v.conf >= 0.8 ? C.vert : v.conf >= 0.5 ? C.ambre : C.rouge;
  const cFiab = v.fiab === F.HUMAIN ? C.vert : v.fiab === F.LLM ? C.violet : v.fiab === F.API ? C.bleu : C.txt3;

  const valider = () => {
    const val = tmp === '' ? null : (ratio && +tmp > 1 ? +tmp / 100 : +tmp);
    onSet(k, V(val, { unite: v.unite, fiab: val == null ? F.ABSENT : F.HUMAIN, conf: 1, source: 'Saisie manuelle', citation: v.citation, note: '' }));
    setEd(false);
  };

  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${C.bord}` }}>
      <div className="row" style={{ gap: 9 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span style={{ fontSize: 12.5 }}>{LIB_REGLES[k]}</span>
            <span className="tag" style={{ background: `${cFiab}1a`, color: cFiab }}>{F_LABEL[v.fiab]}</span>
          </div>
          {v.citation && (
            <div style={{ fontSize: 11, color: C.txt3, marginTop: 4, fontStyle: 'italic', borderLeft: `2px solid ${C.bord2}`, paddingLeft: 8, lineHeight: 1.45 }}>
              « {v.citation} »
            </div>
          )}
          {v.note && (
            <div style={{ fontSize: 11, color: C.ambre, marginTop: 4, lineHeight: 1.45 }}>⚠ {v.note}</div>
          )}
        </div>

        {ed ? (
          <div className="row" style={{ gap: 5, flexShrink: 0 }}>
            <input className="mono" type="number" step="any" value={tmp} autoFocus
              onChange={(e) => setTmp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && valider()}
              style={{ width: 84, padding: '5px 7px', fontSize: 12 }} />
            <button className="btn btn-p" onClick={valider} style={{ padding: '5px 10px', fontSize: 11 }}>OK</button>
          </div>
        ) : (
          <div onClick={() => { setTmp(v.val == null ? '' : (ratio ? v.val * 100 : v.val)); setEd(true); }}
            style={{ textAlign: 'right', cursor: 'pointer', flexShrink: 0, minWidth: 86 }}>
            <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: connue(v) ? C.txt : C.txt3 }}>
              {aff ?? 'non défini'}
            </div>
            {connue(v) && (
              <div className="row" style={{ gap: 4, justifyContent: 'flex-end', marginTop: 3 }}>
                <div style={{ width: 32, height: 3, background: C.bord, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${v.conf * 100}%`, height: '100%', background: cConf }} />
                </div>
                <span className="mono" style={{ fontSize: 9, color: cConf }}>{Math.round(v.conf * 100)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   FICHE TERRAIN
   ══════════════════════════════════════════════════════════════════════════ */
/* ── Plan 2D de la parcelle, tracé depuis la géométrie cadastrale ────────── */
function PlanParcelle({ geometrie, surface, emprise }) {
  const anneau = anneauExt(geometrie);
  if (!anneau || anneau.length < 3) return null;
  const pts = toXY(anneau);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const pad = Math.max(w, h) * 0.08;
  const vb = `${minX - pad} ${-(maxY + pad)} ${w + 2 * pad} ${h + 2 * pad}`;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${(-p[1]).toFixed(1)}`).join(' ') + ' Z';

  // Dimensions approximatives du rectangle englobant
  const largeur = Math.round(w), profondeur = Math.round(h);

  return (
    <div className="pan" style={{ padding: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="eyebrow">Forme de la parcelle</div>
        <div className="mono" style={{ fontSize: 10, color: C.txt3 }}>cadastre IGN</div>
      </div>
      <div style={{ background: C.fond, borderRadius: 6, padding: 16, border: `1px solid ${C.bord}` }}>
        <svg viewBox={vb} style={{ width: '100%', height: 220, display: 'block' }} preserveAspectRatio="xMidYMid meet">
          <path d={d} fill="rgba(224,163,65,.12)" stroke={C.ambre} strokeWidth={Math.max(w, h) / 160} strokeLinejoin="round" />
        </svg>
      </div>
      <div className="row" style={{ justifyContent: 'space-around', marginTop: 14 }}>
        {[['Surface', `${num(surface)} m²`], ['Emprise ~', `${largeur} × ${profondeur} m`], ['Bâtissable', emprise ? `${num(emprise)} m²` : '—']].map(([l, v]) => (
          <div key={l} style={{ textAlign: 'center' }}>
            <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>{l}</div>
            <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: C.txt3, marginTop: 12, lineHeight: 1.5, textAlign: 'center' }}>
        Contour réel issu du cadastre. Les dimensions sont celles du rectangle englobant (indicatives).
      </div>
    </div>
  );
}

/* ── Bloc d'aide contextuelle : où trouver une donnée à saisir ───────────── */
function Tuto({ titre, etapes, lien, lienLabel }) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <div style={{ marginTop: 10, border: `1px solid ${C.bleu}44`, borderRadius: 6, overflow: 'hidden' }}>
      <div className="row" onClick={() => setOuvert((o) => !o)}
        style={{ padding: '9px 12px', cursor: 'pointer', background: 'rgba(90,145,196,.08)', gap: 7 }}>
        <span style={{ fontSize: 13 }}>💡</span>
        <span className="grow" style={{ fontSize: 12, fontWeight: 500, color: C.bleu }}>{titre}</span>
        <span className="mono" style={{ fontSize: 10, color: C.bleu }}>{ouvert ? '▾' : '▸'}</span>
      </div>
      {ouvert && (
        <div className="slidein" style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.6, color: C.txt2 }}>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {etapes.map((e, i) => <li key={i} style={{ marginBottom: 4 }}>{e}</li>)}
          </ol>
          {lien && (
            <a href={lien} target="_blank" rel="noreferrer"
              style={{ display: 'inline-block', marginTop: 10, color: C.ambre, fontSize: 12, fontWeight: 500, textDecoration: 'none' }}>
              → {lienLabel || 'Ouvrir le site'}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Fiche({ dossier, regles, jeu, onRegles, onPrix, onPrixVente, onRetour, onSave, sauve }) {
  const [ongl, setOngl] = useState('verdict');
  const [texteP, setTexteP] = useState('');
  const [extrait, setExtrait] = useState(false);
  const [errX, setErrX] = useState('');
  const [etiq, setEtiq] = useState('');
  const [autoEtiq, setAutoEtiq] = useState(null);   // 'ok' | 'ko' | 'test' | null

  const modeEtiquette = estPluEtiquette(dossier.zonage);

  // Tentative de lecture automatique de l'étiquette à l'ouverture d'un PLU à étiquettes
  useEffect(() => {
    if (!modeEtiquette || completude(regles) > 0) return;
    let vivant = true;
    (async () => {
      setAutoEtiq('test');
      const geomParam = dossier.geometrie ? encodeURIComponent(JSON.stringify(dossier.geometrie)) : null;
      const lu = await lireEtiquetteAuto(geomParam);
      if (!vivant) return;
      if (lu) {
        const ligne = `${lu.hf} ${lu.hv || ''} ${lu.ces} ${lu.cept}`.trim();
        setEtiq(ligne);
        setAutoEtiq('ok');
      } else {
        setAutoEtiq('ko');
      }
    })();
    return () => { vivant = false; };
  }, [dossier.id, modeEtiquette]);

  const appliquerEtiquette = () => {
    const et = parserEtiquette(etiq);
    if (!et) return;
    onRegles(etiquetteVersRegles(et, dossier.zonage));
    setOngl('capacite');
  };

  const killers = useMemo(() => chercherKillers(dossier, jeu), [dossier, jeu]);
  const env = useMemo(() => calculerEnveloppe(dossier, regles, jeu), [dossier, regles, jeu]);
  const bil = useMemo(() => (env ? bilan(env, dossier, jeu) : null), [env, dossier, jeu]);
  const mc = useMemo(() => monteCarlo(dossier, regles, jeu, 1200), [dossier, regles, jeu]);
  const scn = useMemo(() => (env ? scenarios(env, dossier, jeu, mc) : null), [env, dossier, jeu, mc]);
  const verdict = useMemo(() => rendreVerdict(killers, mc, dossier.prix_demande, regles), [killers, mc, dossier, regles]);

  const vs = VERDICTS[verdict.v];
  const comp = completude(regles);

  const lancerExtraction = async () => {
    if (!texteP.trim()) return;
    setExtrait(true); setErrX('');
    try {
      const j = await extrairePLU(texteP, dossier.zonage);
      const R = jsonVersRegles(j);
      onRegles(R);
      await store.set(`plu:${dossier.code_insee}:${dossier.zonage || R.zone}`, { regles: R, le: new Date().toISOString() });
      setOngl('regles');
    } catch (e) {
      setErrX('L\'extraction a échoué. Le texte est peut-être trop long ou mal structuré. Réessayez avec la seule section de votre zone.');
    }
    setExtrait(false);
  };

  const ONGLETS = [
    ['verdict', 'Verdict'],
    ['scenarios', 'Scénarios'],
    ['synthese', 'Synthèse'],
    ['regles', `Règles PLU ${comp > 0 ? `· ${Math.round(comp * 100)} %` : ''}`],
    ['capacite', 'Capacité'],
    ['bilan', 'Bilan'],
    ['contraintes', `Contraintes ${killers.length ? `· ${killers.length}` : ''}`],
    ['sources', 'Sources'],
  ];

  return (
    <div className="slidein">
      {/* En-tête */}
      <div className="row" style={{ gap: 14, marginBottom: 20 }}>
        <button className="btn btn-g" onClick={onRetour} style={{ fontSize: 18, padding: '4px 8px' }}>←</button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ fontSize: 17, fontWeight: 600 }}>{dossier.ref || 'Parcelle'}</span>
            {dossier.zonage && (
              <span className="tag" style={{ background: 'rgba(90,145,196,.14)', color: C.bleu }}>{dossier.zonage}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: C.txt3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {dossier.adresse || dossier.commune} {dossier.code_insee && `· ${dossier.code_insee}`}
          </div>
        </div>
        <button className="btn btn-s" onClick={onSave}>{sauve ? '✓ Enregistré' : 'Enregistrer'}</button>
      </div>

      {/* Bandeau verdict */}
      <div style={{ background: vs.bg, border: `1px solid ${vs.bd}`, borderRadius: 8, padding: '18px 22px', marginBottom: 18 }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="mono" style={{ fontSize: 26, color: vs.c, lineHeight: 1, marginTop: 2 }}>{vs.ic}</div>
          <div className="grow">
            <div style={{ fontSize: 17, fontWeight: 600, color: vs.c, letterSpacing: '-.01em' }}>{verdict.label}</div>
            <div style={{ fontSize: 13, color: C.txt2, marginTop: 4, lineHeight: 1.5 }}>{verdict.raison}</div>
            {verdict.detail?.length > 0 && (
              <div className="row" style={{ gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
                {verdict.detail.map((c) => (
                  <span key={c} className="tag mono" style={{ background: C.panneau2, color: C.txt3 }}>{c}</span>
                ))}
              </div>
            )}
          </div>
          {mc && verdict.v !== 'mort' && (
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div className="eyebrow" style={{ marginBottom: 4 }}>Prix terrain admissible</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: C.txt, letterSpacing: '-.02em' }}>{eur(mc.median)}</div>
              <div className="mono" style={{ fontSize: 11, color: C.txt3, marginTop: 2 }}>{eur(mc.p10)} — {eur(mc.p90)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Onglets */}
      <div className="row" style={{ gap: 2, borderBottom: `1px solid ${C.bord}`, marginBottom: 18, overflowX: 'auto' }}>
        {ONGLETS.map(([k, l]) => (
          <button key={k} onClick={() => setOngl(k)}
            style={{
              padding: '9px 15px', fontSize: 12.5, whiteSpace: 'nowrap',
              color: ongl === k ? C.txt : C.txt3, fontWeight: ongl === k ? 600 : 400,
              borderBottom: `2px solid ${ongl === k ? C.ambre : 'transparent'}`, marginBottom: -1,
            }}>{l}</button>
        ))}
      </div>

      {/* ── VERDICT ───────────────────────────────────────────────────────── */}
      {ongl === 'verdict' && (
        <div className="slidein">
          {dossier.repartition && (
            <div className="pan" style={{ padding: 18, marginBottom: 16, borderColor: C.ambre2 }}>
              <div className="eyebrow" style={{ marginBottom: 12, color: C.ambre }}>Terrain multi-zone — répartition des surfaces</div>
              <div style={{ display: 'flex', height: 30, borderRadius: 5, overflow: 'hidden', border: `1px solid ${C.bord}` }}>
                {dossier.repartition.repartition.map((r) => (
                  <div key={r.zone} className="row mono" style={{
                    width: `${r.part * 100}%`, justifyContent: 'center', fontSize: 11, fontWeight: 600,
                    background: r.activites ? 'rgba(209,89,106,.25)' : 'rgba(75,168,125,.25)',
                    color: r.activites ? C.rouge : C.vert, minWidth: 40,
                  }}>{r.zone}</div>
                ))}
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
                {dossier.repartition.repartition.map((r) => (
                  <span key={r.zone} className="mono" style={{ fontSize: 11, color: r.activites ? C.rouge : C.vert }}>
                    {r.zone} · {num(r.m2)} m² ({pct(r.part)}) {r.activites ? '— activités, logement exclu' : '— résidentiel'}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: C.txt2, marginTop: 10, lineHeight: 1.5 }}>
                Le potentiel logement ci-dessous est calculé sur la seule portion résidentielle
                ({num(dossier.repartition.m2_residentiel)} m²), pas sur la parcelle entière. Répartition estimée
                par croisement géométrique cadastre × zonage (précision ± quelques %).
              </div>
            </div>
          )}
          {mc ? (
            <>
              <div className="pan" style={{ padding: '20px 24px 16px', marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <div className="eyebrow">Distribution du prix de terrain admissible (charge foncière)</div>
                  <div className="mono" style={{ fontSize: 10, color: C.txt3 }}>{num(mc.n)} scénarios</div>
                </div>
                <Distribution mc={mc} prix={dossier.prix_demande} />
              </div>

              <div className="pan" style={{ padding: 18, marginBottom: 16 }}>
                <div className="eyebrow" style={{ marginBottom: 12 }}>Prix demandé par le vendeur</div>
                <div className="row" style={{ gap: 10 }}>
                  <input className="mono" type="number" placeholder="Ex. 650000"
                    value={dossier.prix_demande ?? ''}
                    onChange={(e) => onPrix(e.target.value === '' ? null : +e.target.value)}
                    style={{ maxWidth: 200 }} />
                  <span style={{ fontSize: 12, color: C.txt3 }}>
                    {dossier.prix_demande
                      ? `Le verdict se recalcule immédiatement.`
                      : `Sans prix, le verdict porte seulement sur la faisabilité technique.`}
                  </span>
                </div>
              </div>

              {/* ── Ce qui s'est vendu autour (DVF, section cadastrale) ── */}
              {dossier.comparables?.length > 0 && (
                <div className="pan" style={{ padding: 18, marginBottom: 16 }}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                    <div className="eyebrow">Vendu dans le voisinage {dossier.prix_m2_dvf?.echelle ? `(${dossier.prix_m2_dvf.echelle})` : ''}</div>
                    <div className="row" style={{ gap: 8 }}>
                      {dossier.prix_m2_dvf && (
                        <span className="tag" style={{
                          background: dossier.prix_m2_dvf.fiable ? `${C.vert}1a` : `${C.ambre}1a`,
                          color: dossier.prix_m2_dvf.fiable ? C.vert : C.ambre,
                        }}>
                          {dossier.prix_m2_dvf.fiable ? `médiane ${num(dossier.prix_m2_dvf.median)} €/m² — utilisée au bilan` : 'indicatif seulement'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 8 }}>
                    {dossier.comparables.slice(0, 8).map((c, i) => (
                      <div key={i} style={{ background: C.fond, border: `1px solid ${C.bord}`, borderRadius: 5, padding: '10px 12px' }}>
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 11, color: C.txt3 }}>{c.type}</span>
                          <span className="mono" style={{ fontSize: 10, color: C.txt3 }}>{(c.date || '').slice(0, 7)}</span>
                        </div>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{num(c.prix_m2)} €/m²</div>
                        <div className="mono" style={{ fontSize: 10, color: C.txt3, marginTop: 1 }}>{eur(c.valeur)} · {num(c.surface)} m²</div>
                      </div>
                    ))}
                  </div>
                  {dossier.prix_m2_dvf?.note && (
                    <div style={{ fontSize: 11, color: C.ambre, marginTop: 10, lineHeight: 1.5 }}>⚠ {dossier.prix_m2_dvf.note}</div>
                  )}
                  <div style={{ fontSize: 10.5, color: C.txt3, marginTop: 8, lineHeight: 1.5 }}>
                    Ventes enregistrées (DVF), dédupliquées par mutation, ventes en bloc écartées.
                    Le DVF ne renseigne ni l'état du bien ni son contexte, et une moyenne de secteur peut diluer un emplacement
                    particulièrement recherché : ces prix situent le marché, ils ne valorisent pas ce terrain précis.
                  </div>
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.bord}` }}>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: C.txt2, flexShrink: 0 }}>
                        Ce prix vous semble faux pour cet emplacement ? Forcez une valeur :
                      </span>
                      <input className="mono" type="number" placeholder="ex. 6500"
                        value={dossier.prix_vente_force ?? ''}
                        onChange={(e) => onPrixVente(e.target.value === '' ? null : +e.target.value)}
                        style={{ maxWidth: 130, padding: '6px 9px', fontSize: 12 }} />
                      <span style={{ fontSize: 11, color: C.txt3 }}>€/m²</span>
                      {dossier.prix_vente_force && (
                        <button className="btn-g" onClick={() => onPrixVente(null)} style={{ fontSize: 11, color: C.txt3 }}>↺ revenir au DVF</button>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: dossier.prix_vente_force ? C.ambre : C.txt3, marginTop: 8 }}>
                      Prix effectivement utilisé au bilan : {num(dossier.prix_vente_force || (dossier.prix_m2_dvf?.fiable ? dossier.prix_m2_dvf.median : jeu.prix_vente_m2.v))} €/m²
                      {dossier.prix_vente_force ? ' (forcé)' : dossier.prix_m2_dvf?.fiable ? ' (DVF)' : ' (hypothèse par défaut)'}
                    </div>
                  </div>
                </div>
              )}

              {/* Surcharge du prix de vente — toujours disponible, même sans DVF */}
              {!dossier.comparables?.length && (
                <div className="pan" style={{ padding: 16, marginBottom: 16 }}>
                  <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: C.txt2 }}>
                      Pas de comparables DVF trouvés — le bilan utilise l'hypothèse par défaut ({num(jeu.prix_vente_m2.v)} €/m²).
                      Prix de vente réel connu ici ?
                    </span>
                    <input className="mono" type="number" placeholder="ex. 6500"
                      value={dossier.prix_vente_force ?? ''}
                      onChange={(e) => onPrixVente(e.target.value === '' ? null : +e.target.value)}
                      style={{ maxWidth: 130, padding: '6px 9px', fontSize: 12 }} />
                    <span style={{ fontSize: 11, color: C.txt3 }}>€/m²</span>
                    {dossier.prix_vente_force && (
                      <button className="btn-g" onClick={() => onPrixVente(null)} style={{ fontSize: 11, color: C.txt3 }}>↺ réinitialiser</button>
                    )}
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
                {[
                  ['SDP médiane', `${num(mc.sdp_med)} m²`, C.txt],
                  ['Logements', num(mc.logts_med), C.txt],
                  ['Scénarios rentables', pct(mc.p_positive), mc.p_positive > 0.7 ? C.vert : mc.p_positive > 0.4 ? C.ambre : C.rouge],
                  ['Fiabilité des règles', pct(confianceRegles(regles)), confianceRegles(regles) > 0.7 ? C.vert : C.ambre],
                ].map(([l, v, c]) => (
                  <div key={l} className="pan" style={{ padding: 14 }}>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>{l}</div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: c }}>{v}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="pan" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Pas assez de données pour calculer</div>
              <div style={{ fontSize: 13, color: C.txt2, maxWidth: 420, margin: '0 auto 18px', lineHeight: 1.6 }}>
                Il manque la surface de la parcelle ou les règles du PLU. Renseignez au moins la hauteur maximale et l'emprise au sol.
              </div>
              <button className="btn btn-p" onClick={() => setOngl('regles')}>Saisir les règles</button>
            </div>
          )}
        </div>
      )}

      {/* ── RÈGLES PLU ────────────────────────────────────────────────────── */}
      {/* ── SCÉNARIOS — trois stratégies côte à côte ──────────────────────── */}
      {ongl === 'scenarios' && (
        <div className="slidein">
          {scn ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12, marginBottom: 16 }}>
                {[scn.promouvoir, scn.louer, scn.revendre].filter(Boolean).map((s, i) => (
                  <div key={i} className="pan" style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{s.titre}</div>
                    <div className="eyebrow" style={{ marginBottom: 10 }}>{s.metrique}</div>
                    <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: C.ambre, letterSpacing: '-.02em' }}>
                      {s.valeur_pct !== undefined ? pct(s.valeur_pct, 1) : eur(s.valeur)}
                    </div>
                    {s.fourchette && (
                      <div className="mono" style={{ fontSize: 11, color: C.txt3, marginTop: 3 }}>
                        {eur(s.fourchette[0])} — {eur(s.fourchette[1])}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: C.txt2, marginTop: 10, lineHeight: 1.5 }}>{s.detail}</div>
                    <div className="grow" />
                    <div style={{ fontSize: 11, color: C.txt3, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.bord}`, lineHeight: 1.5 }}>
                      {s.note}
                    </div>
                    {s.incertain && (
                      <div style={{ fontSize: 11, color: C.ambre, marginTop: 6 }}>
                        ⚠ Sans prix de terrain renseigné, ce rendement suppose un achat à la charge foncière calculée.
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="pan" style={{ padding: 16 }}>
                <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.65 }}>
                  <strong style={{ color: C.txt2 }}>Ces trois chiffrages ne se comparent pas directement</strong> — ils mesurent
                  des choses différentes (un prix d'achat maximal, un rendement annuel, une valeur de revente), avec des horizons,
                  des risques et des métiers différents. Ils situent les ordres de grandeur de chaque voie ; le choix dépend de
                  votre capital, votre fiscalité et votre horizon — que cet outil ne connaît pas. Aucune de ces lignes n'est une
                  recommandation.
                </div>
              </div>
            </>
          ) : (
            <div className="pan" style={{ padding: 32, textAlign: 'center', color: C.txt2, fontSize: 13 }}>
              Les scénarios nécessitent une capacité constructible calculée — renseignez d'abord les règles d'urbanisme.
            </div>
          )}
        </div>
      )}

      {/* ── SYNTHÈSE — page exécutive, imprimable ─────────────────────────── */}
      {ongl === 'synthese' && (
        <div className="slidein">
          <div className="pan" style={{ padding: 24 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-.01em' }}>
                  {dossier.ref} — {dossier.commune}
                </div>
                <div style={{ fontSize: 12, color: C.txt3, marginTop: 2 }}>{dossier.adresse}</div>
              </div>
              <button className="btn btn-s" onClick={() => window.print()}>Imprimer / PDF</button>
            </div>

            <div style={{ margin: '18px 0', padding: '14px 18px', background: vs.bg, border: `1px solid ${vs.bd}`, borderRadius: 6 }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="mono" style={{ fontSize: 20, color: vs.c }}>{vs.ic}</span>
                <div className="grow">
                  <span style={{ fontSize: 15, fontWeight: 700, color: vs.c }}>{verdict.label}</span>
                  <span style={{ fontSize: 13, color: C.txt2, marginLeft: 10 }}>{verdict.raison}</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 18 }}>
              {[
                ['Surface totale', `${num(connue(dossier.surface_m2) ? dossier.surface_m2.val : null)} m²`],
                dossier.repartition ? ['Dont résidentiel', `${num(dossier.repartition.m2_residentiel)} m²`] : null,
                env ? ['SDP potentielle', `${num(env.sdp)} m²`] : null,
                env ? ['Logements', `${num(env.logts)}${env.logts_sociaux ? ` (dont ${env.logts_sociaux} sociaux)` : ''}`] : null,
                mc ? ['Prix terrain admissible (méd.)', eur(mc.median)] : null,
                mc ? ['Fourchette P10–P90', `${eur(mc.p10)} – ${eur(mc.p90)}`] : null,
                bil ? ['CF / CA', pct(bil.ratio_cf_ca)] : null,
                dossier.prix_m2_dvf ? ['Prix marché (DVF)', `${num(dossier.prix_m2_dvf.median)} €/m²`] : null,
              ].filter(Boolean).map(([l, v]) => (
                <div key={l} style={{ background: C.fond, border: `1px solid ${C.bord}`, borderRadius: 6, padding: 12 }}>
                  <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>{l}</div>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>

            {dossier.repartition && (
              <div style={{ marginBottom: 18 }}>
                <div className="eyebrow" style={{ marginBottom: 8 }}>Zonage</div>
                <div style={{ fontSize: 13, color: C.txt2, lineHeight: 1.6 }}>
                  {dossier.repartition.repartition.map((r) =>
                    `${r.zone} : ${num(r.m2)} m² (${pct(r.part)})${r.activites ? ' — zone d\'activités, logement exclu' : ' — résidentiel'}`
                  ).join(' · ')}
                </div>
              </div>
            )}

            {(() => {
              const tous = [...killers, ...dossier.alertes].sort((a, b) =>
                ['bloquant', 'majeur', 'vigilance', 'info'].indexOf(a.sev) - ['bloquant', 'majeur', 'vigilance', 'info'].indexOf(b.sev));
              const top = tous.slice(0, 5);
              return top.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Contraintes structurantes</div>
                  {top.map((k, i) => {
                    const s = SEV[k.sev] || SEV.info;
                    return (
                      <div key={i} className="row" style={{ gap: 8, padding: '5px 0', alignItems: 'flex-start' }}>
                        <span className="tag" style={{ background: `${s.c}1a`, color: s.c, flexShrink: 0, marginTop: 1 }}>{s.l}</span>
                        <span style={{ fontSize: 12.5, color: C.txt2, lineHeight: 1.5 }}>{k.msg}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            <div style={{ paddingTop: 14, borderTop: `1px solid ${C.bord}`, fontSize: 11, color: C.txt3, lineHeight: 1.6 }}>
              Estimation de criblage établie sur données publiques (cadastre IGN, GPU, Géorisques, DVF) et hypothèses
              paramétrables — fourchette Monte-Carlo, pas une expertise. Ne couvre pas : servitudes de droit privé,
              capacité réelle des réseaux, pollution des sols, position de la collectivité. Un terrain retenu ici
              appelle une étude de faisabilité complète avant toute décision d'acquisition.
              <span className="mono" style={{ marginLeft: 6 }}>TERRA · {new Date().toLocaleDateString('fr-FR')}</span>
            </div>
          </div>
        </div>
      )}

      {ongl === 'regles' && (
        <div className="slidein">
          {modeEtiquette ? (
            /* ── Mode étiquette (Toulouse et PLUi modernisés) ── */
            <div className="pan" style={{ padding: 18, marginBottom: 16, borderColor: C.bleu + '55' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div className="eyebrow" style={{ color: C.bleu }}>PLU à étiquettes — zone {dossier.zonage}</div>
                {autoEtiq === 'test' && <span className="pulsing mono" style={{ fontSize: 10, color: C.txt3 }}>lecture auto…</span>}
                {autoEtiq === 'ok' && <span className="tag" style={{ background: `${C.vert}1a`, color: C.vert }}>lue automatiquement</span>}
                {autoEtiq === 'ko' && <span className="tag" style={{ background: `${C.ambre}1a`, color: C.ambre }}>à saisir</span>}
              </div>
              <div style={{ fontSize: 12.5, color: C.txt2, marginBottom: 12, lineHeight: 1.6 }}>
                Sur ce PLUi, la hauteur, l'emprise et la pleine terre ne sont pas dans le texte : elles sont
                sur l'étiquette du plan de zonage, dans l'ordre <strong className="mono">HF · HV · CES · CEPT</strong>.
                {autoEtiq === 'ko' && ' La donnée structurée n\'est pas exposée pour cette commune — relevez l\'étiquette sur le portail d\'urbanisme (10 s) et saisissez-la ci-dessous.'}
                {autoEtiq === 'ok' && ' Valeurs récupérées automatiquement — vérifiez-les avant de valider.'}
              </div>
              <input className="mono" value={etiq} onChange={(e) => setEtiq(e.target.value)}
                placeholder="ex. 15 L 50 25  (HF=15m · HV=L · CES=50% · CEPT=25%)"
                style={{ fontSize: 14, letterSpacing: '.04em' }} />
              {etiq.trim() && (() => {
                const et = parserEtiquette(etiq);
                if (!et) return null;
                const chip = (lab, o) => {
                  const txt = o.code === 'VAL' ? o.v : o.code === 'L' ? 'L (voie)' : o.code === 'NR' ? 'NR' : o.code === 'RE' ? 'RE' : '—';
                  const c = o.code === 'VAL' ? C.txt : o.code === 'RE' || o.code === 'L' ? C.ambre : C.txt3;
                  return (
                    <div key={lab} style={{ textAlign: 'center' }}>
                      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 3 }}>{lab}</div>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 600, color: c }}>{txt}</div>
                    </div>
                  );
                };
                return (
                  <div className="row" style={{ gap: 20, justifyContent: 'center', marginTop: 12, padding: '10px 0', background: C.fond, borderRadius: 5 }}>
                    {chip('HF', et.hf)}{chip('HV', et.hv)}{chip('CES', et.ces)}{chip('CEPT', et.cept)}
                  </div>
                );
              })()}
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <button className="btn btn-p" onClick={appliquerEtiquette} disabled={!etiq.trim()}>Appliquer l'étiquette</button>
                <span style={{ fontSize: 11, color: C.txt3 }}>NR = non réglementé · RE = renvoi au règlement écrit · L = selon largeur de voie</span>
              </div>
              <div style={{ fontSize: 11, color: C.txt3, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.bord}`, lineHeight: 1.5 }}>
                La bande de constructibilité de 15,5 m (disposition commune du PLUi-H) est appliquée automatiquement à l'emprise.
                Le texte du règlement reste utile pour la mixité sociale — collez-le plus bas si besoin.
              </div>
              <Tuto
                titre="Où trouver l'étiquette de ma parcelle ?"
                etapes={[
                  'Ouvrez le portail d\'urbanisme de Toulouse Métropole (lien ci-dessous).',
                  'Cherchez l\'adresse de votre terrain dans la barre de recherche.',
                  'Cliquez sur la parcelle : l\'étiquette apparaît, par exemple « UM3 15 L 50 25 ».',
                  'Lisez les 4 valeurs dans l\'ordre HF · HV · CES · CEPT et recopiez-les ci-dessus.',
                  'Si votre terrain est à cheval sur deux zones, saisissez celle où vous voulez construire du logement.',
                ]}
                lien="https://carto.toulouse-metropole.fr/portailurbanisme"
                lienLabel="Ouvrir le portail d'urbanisme de Toulouse" />
            </div>
          ) : (
            /* ── Mode texte (PLU classiques) ── */
            <div className="pan" style={{ padding: 18, marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Extraire depuis le règlement</div>
              <div style={{ fontSize: 12.5, color: C.txt2, marginBottom: 12, lineHeight: 1.6 }}>
                Collez le texte de la zone <strong className="mono">{dossier.zonage || '(à préciser)'}</strong> tel qu'il figure au règlement.
                Chaque règle extraite sera accompagnée de sa citation et d'un score de confiance. Vous corrigez ce qui est faux — la correction fait autorité.
              </div>
              <textarea rows={7} value={texteP} onChange={(e) => setTexteP(e.target.value)}
                placeholder={`ARTICLE UB-10 — HAUTEUR MAXIMALE DES CONSTRUCTIONS\nLa hauteur maximale est fixée à 12 mètres au faîtage...\n\nARTICLE UB-9 — EMPRISE AU SOL\nL'emprise au sol des constructions ne peut excéder 40 % de l'unité foncière...`}
                style={{ resize: 'vertical', lineHeight: 1.6, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} />
              {errX && <div style={{ fontSize: 12, color: C.rouge, marginTop: 9 }}>{errX}</div>}
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <button className="btn btn-p" onClick={lancerExtraction} disabled={extrait || !texteP.trim()}>
                  {extrait ? <span className="pulsing">Lecture du règlement…</span> : 'Extraire les règles'}
                </button>
                <span style={{ fontSize: 11, color: C.txt3 }}>
                  Le résultat est mis en cache pour {dossier.commune || 'cette commune'}.
                </span>
              </div>
            </div>
          )}

          <div className="pan" style={{ padding: '4px 18px 14px' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '14px 0 6px' }}>
              <div className="eyebrow">Contraintes retenues</div>
              <div className="mono" style={{ fontSize: 10, color: C.txt3 }}>
                {Math.round(comp * 100)} % renseigné · fiabilité {Math.round(confianceRegles(regles) * 100)} %
              </div>
            </div>
            {Object.keys(LIB_REGLES).map((k) => (
              <ChampRegle key={k} k={k} v={regles[k]}
                onSet={(kk, vv) => onRegles({ ...regles, [kk]: vv })} />
            ))}
            <div style={{ fontSize: 11, color: C.txt3, marginTop: 12, lineHeight: 1.5 }}>
              Une règle non définie n'est pas une règle absente. Elle est simplement ignorée par le calcul — ce qui rend l'estimation optimiste.
            </div>
          </div>

          {regles.ambiguites?.length > 0 && (
            <div className="pan" style={{ padding: 18, marginTop: 16, borderColor: C.ambre2 }}>
              <div className="eyebrow" style={{ marginBottom: 12, color: C.ambre }}>Ambiguïtés relevées dans le texte</div>
              {regles.ambiguites.map((a, i) => (
                <div key={i} style={{ padding: '10px 0', borderTop: i ? `1px solid ${C.bord}` : 'none' }}>
                  <div className="mono" style={{ fontSize: 11, color: C.ambre, marginBottom: 3 }}>{LIB_REGLES[a.regle] || a.regle}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{a.probleme}</div>
                  {a.impact && <div style={{ fontSize: 12, color: C.txt3, marginTop: 3 }}>Conséquence : {a.impact}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CAPACITÉ ──────────────────────────────────────────────────────── */}
      {ongl === 'capacite' && (
        <div className="slidein">
          {env ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 16 }}>
                {[
                  ['Surface de plancher', `${num(env.sdp)} m²`],
                  ['Emprise au sol', `${num(env.emprise)} m²`],
                  ['Niveaux', `R+${env.niveaux - 1}`],
                  ['Logements', num(env.logts)],
                  ['Dont sociaux', num(env.logts_sociaux)],
                  ['Places de parking', num(env.places)],
                ].map(([l, v]) => (
                  <div key={l} className="pan" style={{ padding: 14 }}>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>{l}</div>
                    <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
              </div>

              <div className="pan" style={{ padding: 18, marginBottom: 16 }}>
                <div className="eyebrow" style={{ marginBottom: 12 }}>Ce qui limite la capacité</div>
                <div className="row" style={{ gap: 10, marginBottom: 14 }}>
                  <span className="tag" style={{ background: 'rgba(224,163,65,.14)', color: C.ambre, fontSize: 11, padding: '4px 10px' }}>
                    {env.contrainte_active}
                  </span>
                  <span style={{ fontSize: 12, color: C.txt2 }}>
                    L'emprise retenue représente {pct(env.emprise_ratio)} de la parcelle.
                  </span>
                </div>
                <div style={{ height: 26, background: C.fond, borderRadius: 4, overflow: 'hidden', position: 'relative', border: `1px solid ${C.bord}` }}>
                  <div style={{ width: `${Math.min(100, env.emprise_ratio * 100)}%`, height: '100%', background: `linear-gradient(90deg,${C.ambre2},${C.ambre})`, transition: 'width .3s' }} />
                  <div className="mono row" style={{ position: 'absolute', inset: 0, justifyContent: 'center', fontSize: 11, fontWeight: 600, color: C.txt }}>
                    {num(env.emprise)} m² sur {num(env.surface_parcelle)} m²
                  </div>
                </div>
                {env.recul_applique > 0 && (
                  <div style={{ fontSize: 11.5, color: C.txt3, marginTop: 10 }}>
                    Recul appliqué : {num(env.recul_applique, 1)} m sur tout le pourtour. L'érosion est calculée sur la géométrie réelle de la parcelle.
                  </div>
                )}
              </div>

              {/* Décomposition par typologie — répond à "c'est quoi, un logement ?" */}
              <div className="pan" style={{ padding: 18, marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                  <div className="eyebrow">Décomposition des {env.logts} logements</div>
                  <div className="mono" style={{ fontSize: 10, color: C.txt3 }}>répartition indicative</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                  {env.typologies.map((t) => (
                    <div key={t.type} style={{ background: C.fond, borderRadius: 6, padding: 14, textAlign: 'center', border: `1px solid ${C.bord}` }}>
                      <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: C.ambre }}>{t.nb}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{t.type}</div>
                      <div className="mono" style={{ fontSize: 10, color: C.txt3, marginTop: 3 }}>~{t.surface} m² chacun</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.txt3, marginTop: 12, lineHeight: 1.5 }}>
                  Un « logement » = un appartement vendable. La répartition T2/T3/T4 est une hypothèse
                  (35 / 40 / 25 %) modifiable. Le nombre total vient de la surface habitable ÷ surface moyenne par logement
                  ({num(jeu.surface_moy_logt.v)} m²).
                </div>
              </div>

              {/* Plan 2D réel de la parcelle */}
              {dossier.geometrie && (
                <div style={{ marginBottom: 16 }}>
                  <PlanParcelle geometrie={dossier.geometrie} surface={env.surface_parcelle} emprise={env.emprise} />
                </div>
              )}

              <div className="pan" style={{ padding: 16 }}>
                <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.6 }}>
                  <strong style={{ color: C.txt2 }}>Ce n'est pas un projet.</strong> C'est une enveloppe de capacité : le volume maximal théorique
                  sous contraintes réglementaires. Un architecte en tirera moins — l'écart usuel se situe entre 10 et 20 %.
                </div>
              </div>
            </>
          ) : (
            <div className="pan" style={{ padding: 32, textAlign: 'center', color: C.txt2, fontSize: 13 }}>
              Renseignez la surface et au moins une règle de gabarit pour calculer la capacité.
            </div>
          )}
        </div>
      )}

      {/* ── BILAN ─────────────────────────────────────────────────────────── */}
      {ongl === 'bilan' && (
        <div className="slidein">
          {bil ? (
            <>
              {env.mix_auto && (
                <div className="pan" style={{ padding: 14, marginBottom: 14, borderColor: C.bleu + '55' }}>
                  <div style={{ fontSize: 12.5, color: C.txt2, lineHeight: 1.5 }}>
                    <span style={{ color: C.bleu, fontWeight: 600 }}>Mixité sociale appliquée automatiquement — </span>
                    la SDP ({num(env.sdp)} m²) dépasse le seuil de {num(dossier.sps_detecte?.seuil || jeu.sps_seuil_m2.v)} m² relevé sur ce terrain :
                    {' '}{pct(env.mix_social_applique)} des logements sont comptés en social ({env.logts_sociaux} sur {env.logts}), vendus avec décote au bailleur.
                  </div>
                </div>
              )}
              {bil.coherence === 'haute' && (
                <div className="pan" style={{ padding: 14, marginBottom: 14, borderColor: C.ambre2 }}>
                  <div style={{ fontSize: 12.5, color: C.txt2, lineHeight: 1.5 }}>
                    <span style={{ color: C.ambre, fontWeight: 600 }}>Cohérence à vérifier — </span>
                    le prix du terrain représente {pct(bil.ratio_cf_ca)} du CA, au-dessus de la fourchette usuelle en promotion (10–25 %).
                    Cela signale des hypothèses probablement optimistes (prix de vente élevé ou coûts sous-estimés), pas une aubaine.
                  </div>
                </div>
              )}
              {bil.coherence === 'negative' && (
                <div className="pan" style={{ padding: 14, marginBottom: 14, borderColor: C.rouge + '55' }}>
                  <div style={{ fontSize: 12.5, color: C.txt2, lineHeight: 1.6 }}>
                    <span style={{ color: C.rouge, fontWeight: 600 }}>Opération négative selon ce modèle — </span>
                    les coûts dépassent les recettes avant même de payer le terrain. Avant de conclure que le terrain est sans valeur,
                    vérifiez dans l'ordre : (1) le <strong>prix de vente</strong> utilisé — un DVF non fiable ou absent retombe sur une hypothèse
                    générique, souvent trop basse en centre-ville ; (2) le <strong>taux de logement social</strong>, qui peut avoir été appliqué
                    automatiquement et pèse lourd ; (3) la <strong>hauteur</strong> retenue (un gabarit bas type R+1 rentabilise mal un foncier cher).
                    Un promoteur qui paie cher un terrain a souvent un gabarit, un prix de sortie ou un projet différent de ce que ce criblage suppose par défaut.
                  </div>
                </div>
              )}
              <div className="pan" style={{ padding: 22 }}>
                <div className="eyebrow" style={{ marginBottom: 14 }}>Bilan promoteur — scénario médian</div>

                <Ligne l="Ventes logements libres" v={bil.ca_libre} indent
                  formule={`${env.logts_libres} logts × ${num(jeu.surface_moy_logt.v)} m² × ${eur(dossier.prix_vente_force || (dossier.prix_m2_dvf?.fiable ? dossier.prix_m2_dvf.median : jeu.prix_vente_m2.v))}/m²`}
                  provenance={dossier.prix_vente_force ? 'Prix de vente : forcé manuellement par vous' : dossier.prix_m2_dvf?.fiable ? `Prix de vente : médiane DVF réelle (${dossier.prix_m2_dvf.n} ventes, ${dossier.prix_m2_dvf.echelle})` : 'Prix de vente : hypothèse du preset (modifiable dans Hypothèses, ou forcez-le dans l\'onglet Verdict)'} />
                {bil.ca_social > 0 && <Ligne l="Ventes logements sociaux" v={bil.ca_social} indent
                  formule={`${env.logts_sociaux} logts × surface × prix × (1 − ${pct(jeu.decote_social.v)} décote)`}
                  provenance="Décote logement social : hypothèse (prix bailleur < prix libre)" />}
                {bil.ca_parking > 0 && <Ligne l="Ventes parkings" v={bil.ca_parking} indent
                  formule={`${env.places} places × ${eur(jeu.prix_parking.v)}`}
                  provenance="Prix parking : hypothèse du preset" />}
                <Ligne l="Chiffre d'affaires" v={bil.CA} fort
                  formule="CA = ventes libres + sociales + parkings" />

                <div style={{ height: 14 }} />
                <Ligne l="Construction" v={bil.travaux} indent neg
                  formule={`${num(env.sdp)} m² SDP × ${eur(jeu.cout_travaux_m2.v)}/m²`}
                  provenance="Coût de construction : hypothèse du preset (à recaler sur vos opérations)" />
                {bil.parkings > 0 && <Ligne l="Parkings" v={bil.parkings} indent neg
                  formule={`${env.places} places × ${eur(jeu.cout_parking.v)}`} />}
                {bil.demo > 0 && <Ligne l="Démolition" v={bil.demo} indent neg
                  formule={`${num(connue(dossier.bati_existant_m2) ? dossier.bati_existant_m2.val : 0)} m² × ${eur(jeu.cout_demolition_m2.v)}/m²`} />}
                <Ligne l="VRD et aménagements" v={bil.vrd} indent neg
                  formule={`Forfait ${eur(jeu.vrd_forfait.v)}`} provenance="Voiries, réseaux, espaces verts : hypothèse forfaitaire" />
                <Ligne l="Maîtrise d'œuvre" v={bil.moe} indent neg
                  formule={`${pct(jeu.honoraires_moe.v)} × travaux`} provenance="Architecte, BET, OPC" />
                <Ligne l="Assurances" v={bil.assur} indent neg
                  formule={`${pct(jeu.assurances.v)} × travaux`} />
                <Ligne l="Aléas" v={bil.aleas} indent neg
                  formule={`${pct(jeu.alea.v)} × travaux`} provenance="Provision pour imprévus" />
                <Ligne l="Honoraires de promotion" v={bil.promo} indent neg
                  formule={`${pct(jeu.honoraires_promo.v)} × CA`} />
                <Ligne l="Commercialisation" v={bil.commerc} indent neg
                  formule={`${pct(jeu.commercialisation.v)} × CA`} provenance="Commissions et marketing" />
                <Ligne l="Frais financiers" v={bil.finan} indent neg
                  formule={`${pct(jeu.frais_financiers.v)} × CA`} provenance="Portage sur la durée d'opération" />
                <Ligne l="Taxe d'aménagement" v={bil.ta} indent neg
                  formule={`${num(env.sdp)} m² × ${eur(jeu.taxe_amenagement_m2.v)} × ${pct(jeu.taux_ta.v)}`}
                  provenance="Taxe d'aménagement : valeur forfaitaire × taux communal + départemental" />
                <Ligne l="Total des coûts" v={bil.couts} fort neg
                  formule="Somme de tous les postes de coûts ci-dessus" />

                <div style={{ height: 14 }} />
                <Ligne l={`Marge cible (${pct(jeu.marge_cible.v)})`} v={bil.marge} fort neg
                  formule={`${pct(jeu.marge_cible.v)} × CA`}
                  provenance="Marge nette visée. Sous ce seuil, l'opération ne se fait pas." />

                <div style={{ marginTop: 18, padding: '16px 18px', background: bil.charge_fonciere > 0 ? 'rgba(75,168,125,.08)' : 'rgba(209,89,106,.08)', border: `1px solid ${bil.charge_fonciere > 0 ? 'rgba(75,168,125,.3)' : 'rgba(209,89,106,.3)'}`, borderRadius: 6 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>Prix du terrain admissible <span style={{ fontSize: 11, color: "#96a3b6", fontWeight: 400 }}>(charge foncière)</span></div>
                      <div className="mono" style={{ fontSize: 11, color: C.txt3, marginTop: 3 }}>
                        {eur(bil.cf_m2_sdp)} / m² SDP · {eur(bil.cf_m2_terrain)} / m² de terrain
                      </div>
                      <div style={{ fontSize: 11, color: C.txt3, marginTop: 6, lineHeight: 1.5 }}>
                        = (CA − coûts − marge) ÷ (1 + {pct(jeu.frais_acquisition.v)} frais d'acquisition)
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: bil.charge_fonciere > 0 ? C.vert : C.rouge, letterSpacing: '-.02em' }}>
                      {eur(bil.charge_fonciere)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="pan" style={{ padding: 16, marginTop: 14 }}>
                <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.6 }}>
                  Ce bilan repose sur le scénario médian. Il ne remplace pas la fourchette : allez voir l'onglet
                  <button onClick={() => setOngl('verdict')} style={{ color: C.ambre, fontWeight: 500, padding: '0 3px' }}>Verdict</button>
                  pour la distribution complète. Toutes les hypothèses sont modifiables dans le panneau latéral.
                </div>
              </div>
            </>
          ) : (
            <div className="pan" style={{ padding: 32, textAlign: 'center', color: C.txt2, fontSize: 13 }}>
              Le bilan nécessite une capacité constructible calculée.
            </div>
          )}
        </div>
      )}

      {/* ── CONTRAINTES ───────────────────────────────────────────────────── */}
      {ongl === 'contraintes' && (
        <div className="slidein">
          {[...killers, ...dossier.alertes].length === 0 ? (
            <div className="pan" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.vert, marginBottom: 6 }}>Aucune contrainte détectée</div>
              <div style={{ fontSize: 13, color: C.txt2, maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
                Absence de détection n'est pas absence de contrainte. Les servitudes de droit privé et la capacité des réseaux ne figurent dans aucune base publique.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[...killers, ...dossier.alertes]
                .sort((a, b) => ['bloquant', 'majeur', 'vigilance', 'info'].indexOf(a.sev) - ['bloquant', 'majeur', 'vigilance', 'info'].indexOf(b.sev))
                .map((k, i) => {
                  const s = SEV[k.sev] || SEV.info;
                  return (
                    <div key={i} className="pan" style={{ padding: 15, borderLeft: `3px solid ${s.c}` }}>
                      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                        <span className="tag" style={{ background: `${s.c}1a`, color: s.c }}>{s.l}</span>
                        <span className="mono" style={{ fontSize: 10, color: C.txt3 }}>{k.code}</span>
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.5 }}>{k.msg}</div>
                      {k.action && (
                        <div style={{ fontSize: 12, color: C.txt2, marginTop: 7, paddingTop: 7, borderTop: `1px solid ${C.bord}`, lineHeight: 1.5 }}>
                          <span style={{ color: C.txt3 }}>À vérifier — </span>{k.action}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* ── SOURCES ───────────────────────────────────────────────────────── */}
      {ongl === 'sources' && (
        <div className="slidein">
          <div className="pan" style={{ padding: 18, marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Données collectées</div>
            {[
              ['Référence cadastrale', dossier.ref, dossier.ref ? F.API : F.ABSENT],
              ['Commune', `${dossier.commune} (${dossier.code_insee})`, dossier.code_insee ? F.API : F.ABSENT],
              ['Surface', connue(dossier.surface_m2) ? `${num(dossier.surface_m2.val)} m²` : null, dossier.surface_m2.fiab],
              ['Zonage', dossier.zonage || null, dossier.zonage ? F.API : F.ABSENT],
              ['Prescriptions', dossier.prescriptions.length ? `${dossier.prescriptions.length} relevée(s)` : 'aucune', F.API],
              ['Servitudes', dossier.servitudes.length ? `${dossier.servitudes.length} relevée(s)` : 'aucune', F.API],
              ['Risques', Object.keys(dossier.risques).length ? 'renseignés' : null, Object.keys(dossier.risques).length ? F.API : F.ABSENT],
              ['Prix de vente (DVF)', dossier.prix_m2_dvf ? `${num(dossier.prix_m2_dvf.median)} €/m² (${dossier.prix_m2_dvf.n} ventes, ${dossier.prix_m2_dvf.echelle})` : null, dossier.prix_m2_dvf ? F.API : F.ABSENT],
            ].map(([l, v, f]) => (
              <div key={l} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.bord}` }}>
                <span style={{ fontSize: 12.5, color: C.txt2 }}>{l}</span>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12, color: v ? C.txt : C.txt3 }}>{v || 'non récupéré'}</span>
                  <span className="tag" style={{ background: f === F.ABSENT ? `${C.txt3}1a` : `${C.bleu}1a`, color: f === F.ABSENT ? C.txt3 : C.bleu, minWidth: 52, justifyContent: 'center' }}>
                    {F_LABEL[f]}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {dossier.sources_ko.length > 0 && (
            <div className="pan" style={{ padding: 18, marginBottom: 14, borderColor: C.ambre2 }}>
              <div className="eyebrow" style={{ marginBottom: 10, color: C.ambre }}>Sources non jointes</div>
              <div style={{ fontSize: 12.5, color: C.txt2, marginBottom: 10, lineHeight: 1.6 }}>
                Ces services n'ont pas répondu. Cela ne signifie pas qu'il n'y a pas de contrainte — seulement qu'on ne l'a pas vue.
                En navigateur, la cause la plus fréquente est le blocage CORS ; en production, ces appels passent par votre serveur.
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {dossier.sources_ko.map((s) => (
                  <span key={s} className="tag mono" style={{ background: `${C.ambre}1a`, color: C.ambre }}>{s}</span>
                ))}
              </div>
              {dossier.sources_ko.some((s) => /DVF/.test(s)) && (
                <Tuto
                  titre="Relever les prix de vente à la main (2 minutes)"
                  etapes={[
                    'Ouvrez l\'application DVF d\'Etalab (lien ci-dessous).',
                    `Dans le menu de gauche, choisissez le département, puis la commune (${dossier.commune || 'votre commune'}), puis la section cadastrale (${dossier.ref ? dossier.ref.slice(0, 2) : 'ex. BC'}).`,
                    'Les parcelles vendues s\'affichent en bleu sur la carte : cliquez-en quelques-unes autour de votre terrain.',
                    'Notez les prix et surfaces des ventes de maisons/appartements récentes, et calculez le prix au m² (prix ÷ surface).',
                    'Reportez la valeur médiane dans le panneau Hypothèses → Recettes → « Prix de vente ». Elle alimentera le bilan.',
                  ]}
                  lien="https://app.dvf.etalab.gouv.fr/"
                  lienLabel="Ouvrir l'application DVF (Etalab)" />
              )}
            </div>
          )}

          <div className="pan" style={{ padding: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Ce que cet outil ne sait pas</div>
            <div style={{ fontSize: 12.5, color: C.txt2, lineHeight: 1.7 }}>
              Les servitudes de droit privé, qui figurent dans les actes notariés. La capacité réelle des réseaux, qu'il faut demander au concessionnaire.
              La pollution réelle, qu'il faut sonder. Et ce que le maire acceptera vraiment.
              <br /><br />
              Un terrain retenu ici mérite une étude. Un terrain écarté mérite un coup d'œil avant d'être oublié.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Garde anti-crash : jamais de page noire, toujours un message ────────── */
class Garde extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 30, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.rouge, marginBottom: 8 }}>Une erreur d'affichage s'est produite</div>
          <div style={{ fontSize: 12.5, color: C.txt2, marginBottom: 14, lineHeight: 1.6 }}>
            Le calcul de ce terrain a rencontré un problème. Les autres terrains ne sont pas affectés.
          </div>
          <div className="mono" style={{ fontSize: 10, color: C.txt3, marginBottom: 16 }}>{String(this.state.err?.message || this.state.err).slice(0, 200)}</div>
          <button className="btn btn-s" onClick={() => { this.setState({ err: null }); this.props.onReset?.(); }}>Revenir à la liste</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   PANNEAU HYPOTHÈSES
   ══════════════════════════════════════════════════════════════════════════ */
function PanneauH({ jeu, region, onSet, onReset, onRegion, onResetAll, onClose }) {
  const groupes = useMemo(() => {
    const g = {};
    Object.entries(jeu).forEach(([k, h]) => { (g[h.g] ||= []).push([k, h]); });
    return g;
  }, [jeu]);
  const nbMod = Object.values(jeu).filter((h) => h.src === 'utilisateur').length;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(6,9,13,.7)', backdropFilter: 'blur(2px)' }} />
      <div className="slidein" style={{
        position: 'relative', width: 'min(440px,100%)', height: '100%',
        background: C.panneau, borderLeft: `1px solid ${C.bord}`,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: `1px solid ${C.bord}` }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Hypothèses</div>
            <button className="btn-g" onClick={onClose} style={{ fontSize: 18 }}>×</button>
          </div>
          <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.5 }}>
            Elles s'appliquent à tous les terrains. Chaque valeur est une fourchette, pas un chiffre.
          </div>
        </div>

        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.bord}`, background: C.panneau2 }}>
          <div className="eyebrow" style={{ marginBottom: 7 }}>Preset de départ</div>
          <select value={region} onChange={(e) => onRegion(e.target.value)}>
            {Object.entries(REGIONS).map(([k, r]) => <option key={k} value={k}>{r.nom}</option>)}
          </select>
          {nbMod > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <span className="mono" style={{ fontSize: 11, color: C.ambre }}>{nbMod} valeur{nbMod > 1 ? 's' : ''} modifiée{nbMod > 1 ? 's' : ''}</span>
              <button className="btn-g" onClick={onResetAll} style={{ fontSize: 11, color: C.txt3 }}>Tout réinitialiser</button>
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px 24px' }}>
          {Object.entries(groupes).map(([g, items]) => (
            <div key={g} style={{ marginTop: 16 }}>
              <div className="eyebrow" style={{ padding: '0 4px 8px' }}>{g}</div>
              {items.map(([k, h]) => <ChampH key={k} k={k} h={h} onSet={onSet} onReset={onReset} />)}
            </div>
          ))}
          <div style={{ fontSize: 11, color: C.txt3, marginTop: 20, padding: '14px 8px 0', borderTop: `1px solid ${C.bord}`, lineHeight: 1.6 }}>
            Les presets sont des ordres de grandeur, pas des vérités. Recalez-les sur vos trois dernières opérations et
            l'outil deviendra le vôtre.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   AJOUT DE TERRAINS
   ══════════════════════════════════════════════════════════════════════════ */
function Ajout({ onAdd, onClose }) {
  const [mode, setMode] = useState('adresse');
  const [f, setF] = useState({ adresse: '', insee: '', section: '', numero: '', prix: '' });
  const [lot, setLot] = useState('');
  const [busy, setBusy] = useState(false);
  const [etape, setEtape] = useState(null);
  const [prog, setProg] = useState(null);

  const unSeul = async () => {
    setBusy(true);
    const d = await collecter({
      adresse: f.adresse, insee: f.insee, section: f.section.toUpperCase(),
      numero: f.numero, prix: f.prix ? +f.prix : null,
    }, setEtape);
    setBusy(false); setEtape(null);
    onAdd([d]);
  };

  const enLot = async () => {
    const lignes = lot.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lignes.length) return;
    setBusy(true);
    const out = [];
    for (let i = 0; i < lignes.length; i++) {
      setProg({ i: i + 1, n: lignes.length, l: lignes[i] });
      const [a, p] = lignes[i].split(';').map((s) => s?.trim());
      const d = await collecter({ adresse: a, prix: p ? +p : null }, setEtape);
      out.push(d);
    }
    setBusy(false); setProg(null); setEtape(null);
    onAdd(out);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={busy ? undefined : onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(6,9,13,.75)', backdropFilter: 'blur(3px)' }} />
      <div className="pan slidein" style={{ position: 'relative', width: 'min(540px,100%)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.bord}` }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Ajouter des terrains</div>
            {!busy && <button className="btn-g" onClick={onClose} style={{ fontSize: 18 }}>×</button>}
          </div>
        </div>

        {busy ? (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <div className="pulsing mono" style={{ fontSize: 13, color: C.ambre, marginBottom: 14 }}>
              {etape || 'Collecte en cours'}
            </div>
            {prog && (
              <>
                <div style={{ height: 4, background: C.fond, borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{ width: `${(prog.i / prog.n) * 100}%`, height: '100%', background: C.ambre, transition: 'width .3s' }} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: C.txt3 }}>
                  {prog.i} / {prog.n} — {prog.l.slice(0, 50)}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 2, padding: '0 22px', borderBottom: `1px solid ${C.bord}` }}>
              {[['adresse', 'Par adresse'], ['cadastre', 'Par référence'], ['lot', 'En lot']].map(([k, l]) => (
                <button key={k} onClick={() => setMode(k)} style={{
                  padding: '10px 14px', fontSize: 12.5,
                  color: mode === k ? C.txt : C.txt3, fontWeight: mode === k ? 600 : 400,
                  borderBottom: `2px solid ${mode === k ? C.ambre : 'transparent'}`, marginBottom: -1,
                }}>{l}</button>
              ))}
            </div>

            <div style={{ padding: 22 }}>
              {mode === 'adresse' && (
                <>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Adresse</div>
                  <input value={f.adresse} onChange={(e) => setF({ ...f, adresse: e.target.value })}
                    placeholder="12 rue des Pins, 31000 Toulouse" autoFocus />
                  <div className="eyebrow" style={{ margin: '14px 0 6px' }}>Prix demandé (facultatif)</div>
                  <input className="mono" type="number" value={f.prix} onChange={(e) => setF({ ...f, prix: e.target.value })} placeholder="650000" />
                  <div style={{ fontSize: 11.5, color: C.txt3, marginTop: 8, lineHeight: 1.5 }}>
                    Sans prix, le verdict porte seulement sur la faisabilité. Avec, il tranche.
                  </div>
                </>
              )}

              {mode === 'cadastre' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 10 }}>
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Code INSEE</div>
                      <input className="mono" value={f.insee} onChange={(e) => setF({ ...f, insee: e.target.value })} placeholder="31555" maxLength={5} autoFocus />
                    </div>
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Section</div>
                      <input className="mono" value={f.section} onChange={(e) => setF({ ...f, section: e.target.value.toUpperCase() })} placeholder="AB" maxLength={2} />
                    </div>
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Numéro</div>
                      <input className="mono" value={f.numero} onChange={(e) => setF({ ...f, numero: e.target.value })} placeholder="0142" />
                    </div>
                  </div>
                  <div className="eyebrow" style={{ margin: '14px 0 6px' }}>Prix demandé (facultatif)</div>
                  <input className="mono" type="number" value={f.prix} onChange={(e) => setF({ ...f, prix: e.target.value })} placeholder="650000" />
                </>
              )}

              {mode === 'lot' && (
                <>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Une ligne par terrain</div>
                  <textarea rows={8} value={lot} onChange={(e) => setLot(e.target.value)}
                    placeholder={`12 rue des Pins, 31000 Toulouse; 650000\n4 av Jean Jaurès, 31000 Toulouse; 420000\n8 chemin du Lac, 31200 Toulouse`}
                    style={{ resize: 'vertical', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, lineHeight: 1.7 }} />
                  <div style={{ fontSize: 11.5, color: C.txt3, marginTop: 8, lineHeight: 1.5 }}>
                    Format : adresse, puis point-virgule, puis prix. Le prix est facultatif.
                    Comptez environ trois secondes par terrain.
                  </div>
                </>
              )}
            </div>

            <div className="row" style={{ padding: '0 22px 22px', gap: 10 }}>
              <button className="btn btn-p" onClick={mode === 'lot' ? enLot : unSeul}
                disabled={mode === 'lot' ? !lot.trim() : (mode === 'adresse' ? !f.adresse.trim() : !f.insee)}>
                {mode === 'lot' ? `Analyser ${lot.split('\n').filter((l) => l.trim()).length || ''} terrain(s)` : 'Analyser'}
              </button>
              <button className="btn btn-g" onClick={onClose}>Annuler</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   RACINE
   ══════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [terrains, setTerrains] = useState([]);
  const [regles, setRegles] = useState({});   // id → règles
  const [sel, setSel] = useState(null);
  const [region, setRegion] = useState('standard');
  const [jeu, setJeu] = useState(() => buildJeu('standard'));
  const [panH, setPanH] = useState(false);
  const [ajout, setAjout] = useState(false);
  const [filtre, setFiltre] = useState('tous');
  const [charge, setCharge] = useState(true);
  const [sauve, setSauve] = useState(false);

  /* Chargement */
  useEffect(() => {
    (async () => {
      const st = await store.get('terra:etat');
      if (st) {
        setTerrains(st.terrains || []);
        setRegles(st.regles || {});
        setRegion(st.region || 'standard');
        if (st.jeu) setJeu(st.jeu);
      }
      setCharge(false);
    })();
  }, []);

  /* Sauvegarde */
  const persister = useCallback(async (t = terrains, r = regles, j = jeu, rg = region) => {
    await store.set('terra:etat', { terrains: t, regles: r, jeu: j, region: rg });
  }, [terrains, regles, jeu, region]);

  useEffect(() => { if (!charge) persister(); }, [terrains, regles, jeu, region, charge]);

  /* Hypothèses */
  const setH = (k, patch) => setJeu((j) => ({ ...j, [k]: { ...j[k], ...patch } }));
  const resetH = (k) => setJeu((j) => ({ ...j, [k]: { ...buildJeu(region)[k] } }));
  const resetAllH = () => setJeu(buildJeu(region));
  const changerRegion = (r) => { setRegion(r); setJeu(buildJeu(r)); };

  /* Ajout */
  const ajouter = async (nouveaux) => {
    setAjout(false);
    const rs = { ...regles };
    for (const d of nouveaux) {
      const cache = await store.get(`plu:${d.code_insee}:${d.zonage}`);
      rs[d.id] = cache?.regles || REGLES_VIDE();
    }
    setRegles(rs);
    setTerrains((t) => [...nouveaux, ...t]);
    if (nouveaux.length === 1) setSel(nouveaux[0].id);
  };

  /* Analyses dérivées */
  const analyses = useMemo(() => {
    const m = {};
    terrains.forEach((d) => {
      try {
        const R = regles[d.id] || REGLES_VIDE();
        const k = chercherKillers(d, jeu);
        const mc = monteCarlo(d, R, jeu, 350);   // échantillon réduit pour la liste
        m[d.id] = { killers: k, mc, verdict: rendreVerdict(k, mc, d.prix_demande, R) };
      } catch (e) {
        console.error('analyse KO', d.id, e);
        m[d.id] = { killers: [], mc: null, verdict: { v: 'inconnu', label: 'Erreur de calcul', raison: 'Ce terrain n\'a pas pu être analysé (données incompatibles). Supprimez-le et relancez la collecte.', detail: [] } };
      }
    });
    return m;
  }, [terrains, regles, jeu]);

  const visibles = terrains.filter((d) => filtre === 'tous' || analyses[d.id]?.verdict.v === filtre);
  const compte = (v) => terrains.filter((d) => analyses[d.id]?.verdict.v === v).length;

  const courant = terrains.find((d) => d.id === sel);

  const supprimer = (id) => {
    setTerrains((t) => t.filter((x) => x.id !== id));
    setRegles((r) => { const n = { ...r }; delete n[id]; return n; });
    if (sel === id) setSel(null);
  };

  const exporter = () => {
    const blob = new Blob([JSON.stringify({ v: 1, terrains, regles, jeu, region, le: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terra-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  if (charge) {
    return (
      <div id="terra"><style>{CSS}</style>
        <div className="row pulsing" style={{ height: '100vh', justifyContent: 'center', color: C.txt3, fontSize: 13 }}>Chargement</div>
      </div>
    );
  }

  return (
    <div id="terra">
      <style>{CSS}</style>

      {/* Barre */}
      <div style={{ borderBottom: `1px solid ${C.bord}`, background: C.panneau, position: 'sticky', top: 0, zIndex: 20 }}>
        <div className="row" style={{ maxWidth: 1140, margin: '0 auto', padding: '13px 22px', gap: 14 }}>
          <div className="row" style={{ gap: 9 }}>
            <div style={{ width: 22, height: 22, border: `2px solid ${C.ambre}`, borderRadius: 3, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 3, borderLeft: `2px solid ${C.ambre}`, borderBottom: `2px solid ${C.ambre}`, opacity: .5 }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.02em' }}>TERRA</div>
              <div className="eyebrow" style={{ fontSize: 9, marginTop: -1 }}>Criblage foncier</div>
            </div>
          </div>
          <span className="grow" />
          <button className="btn btn-s" onClick={() => setPanH(true)}>
            Hypothèses
            {Object.values(jeu).filter((h) => h.src === 'utilisateur').length > 0 && (
              <span className="mono" style={{ fontSize: 10, color: C.ambre }}>
                ·{Object.values(jeu).filter((h) => h.src === 'utilisateur').length}
              </span>
            )}
          </button>
          {terrains.length > 0 && <button className="btn btn-s" onClick={exporter}>Exporter</button>}
          <button className="btn btn-p" onClick={() => setAjout(true)}>+ Terrain</button>
        </div>
      </div>

      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '26px 22px 60px' }}>
        {courant ? (
          <Garde onReset={() => setSel(null)}>
            <Fiche
            dossier={courant}
            regles={regles[courant.id] || REGLES_VIDE()}
            jeu={jeu}
            onRegles={(R) => setRegles((r) => ({ ...r, [courant.id]: R }))}
            onPrix={(p) => setTerrains((t) => t.map((x) => (x.id === courant.id ? { ...x, prix_demande: p } : x)))}
            onPrixVente={(p) => setTerrains((t) => t.map((x) => (x.id === courant.id ? { ...x, prix_vente_force: p } : x)))}
            onRetour={() => setSel(null)}
            onSave={async () => { await persister(); setSauve(true); setTimeout(() => setSauve(false), 1800); }}
            sauve={sauve}
          />
          </Garde>
        ) : terrains.length === 0 ? (
          /* ── Vide ── */
          <div style={{ padding: '70px 20px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
            <div className="mono" style={{ fontSize: 12, color: C.ambre, marginBottom: 20, letterSpacing: '.1em' }}>
              CRIBLER, PAS RÉDIGER
            </div>
            <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.03em', lineHeight: 1.2, marginBottom: 16 }}>
              Combien puis-je payer ce terrain ?
            </h1>
            <p style={{ fontSize: 14.5, color: C.txt2, lineHeight: 1.7, marginBottom: 28 }}>
              TERRA collecte le cadastre, le zonage, les servitudes et les risques, lit le règlement du PLU,
              calcule une enveloppe constructible et remonte la charge foncière admissible pour votre marge cible.
              En fourchette, jamais en chiffre unique.
            </p>
            <button className="btn btn-p" onClick={() => setAjout(true)} style={{ padding: '12px 24px', fontSize: 14 }}>
              Analyser un premier terrain
            </button>
            <div style={{ marginTop: 44, paddingTop: 28, borderTop: `1px solid ${C.bord}`, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 22, textAlign: 'left' }}>
              {[
                ['Il dit non vite', 'Zone naturelle, EBC, PPRI rouge : écarté en quelques secondes, sans calcul.'],
                ['Il doute à voix haute', 'Chaque règle porte sa citation et son score de confiance. Les ambiguïtés sont nommées.'],
                ['Il ne remplace personne', 'Un terrain retenu ici mérite une vraie étude. C\'est le tri qui change, pas la décision.'],
              ].map(([t, d]) => (
                <div key={t}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t}</div>
                  <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.6 }}>{d}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* ── Liste ── */
          <>
            <div className="row" style={{ gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
              {[
                ['tous', 'Tous', terrains.length, C.txt2],
                ['creuser', 'À creuser', compte('creuser'), C.vert],
                ['marginal', 'Marginal', compte('marginal'), C.ambre],
                ['mort', 'Écartés', compte('mort'), C.rouge],
                ['inconnu', 'Incomplets', compte('inconnu'), C.txt3],
              ].map(([k, l, n, c]) => (
                <button key={k} onClick={() => setFiltre(k)} style={{
                  padding: '7px 13px', borderRadius: 5, fontSize: 12.5,
                  background: filtre === k ? C.panneau2 : 'transparent',
                  border: `1px solid ${filtre === k ? C.bord2 : 'transparent'}`,
                  color: filtre === k ? C.txt : C.txt3, fontWeight: filtre === k ? 600 : 400,
                }}>
                  {l} <span className="mono" style={{ color: c, marginLeft: 3 }}>{n}</span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibles.map((d) => {
                const a = analyses[d.id];
                const vs = VERDICTS[a.verdict.v];
                const R = regles[d.id] || REGLES_VIDE();
                const c = completude(R);
                return (
                  <div key={d.id} onClick={() => setSel(d.id)} className="pan"
                    style={{ padding: 15, cursor: 'pointer', borderLeft: `3px solid ${vs.c}`, transition: 'border-color .12s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.bord2; e.currentTarget.style.borderLeftColor = vs.c; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.bord; e.currentTarget.style.borderLeftColor = vs.c; }}>
                    <div className="row" style={{ gap: 14 }}>
                      <div className="mono" style={{ fontSize: 17, color: vs.c, width: 20, textAlign: 'center', flexShrink: 0 }}>{vs.ic}</div>

                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 7, marginBottom: 2 }}>
                          <span className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{d.ref || '—'}</span>
                          {d.zonage && <span className="tag" style={{ background: 'rgba(90,145,196,.14)', color: C.bleu }}>{d.zonage}</span>}
                          {c < 0.3 && <span className="tag" style={{ background: `${C.txt3}1a`, color: C.txt3 }}>PLU à saisir</span>}
                        </div>
                        <div style={{ fontSize: 12, color: C.txt3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.adresse || d.commune || '—'}
                        </div>
                        <div style={{ fontSize: 11.5, color: C.txt2, marginTop: 5, lineHeight: 1.4 }}>{a.verdict.raison}</div>
                      </div>

                      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 120 }}>
                        {a.mc && a.verdict.v !== 'mort' ? (
                          <>
                            <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{eur(a.mc.median)}</div>
                            <div className="mono" style={{ fontSize: 10, color: C.txt3, marginTop: 1 }}>
                              {eur(a.mc.p10)} — {eur(a.mc.p90)}
                            </div>
                            {d.prix_demande > 0 && (
                              <div className="mono" style={{ fontSize: 10, marginTop: 3, color: d.prix_demande <= a.mc.median ? C.vert : C.rouge }}>
                                demandé {eur(d.prix_demande)}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="mono" style={{ fontSize: 12, color: C.txt3 }}>—</div>
                        )}
                      </div>

                      <button className="btn-g" onClick={(e) => { e.stopPropagation(); supprimer(d.id); }}
                        style={{ fontSize: 15, color: C.txt3, flexShrink: 0 }}>×</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {visibles.length === 0 && (
              <div className="pan" style={{ padding: 40, textAlign: 'center', color: C.txt3, fontSize: 13 }}>
                Aucun terrain dans cette catégorie.
              </div>
            )}

            {filtre === 'mort' && visibles.length > 0 && (
              <div className="pan" style={{ padding: 16, marginTop: 12, borderColor: C.bord }}>
                <div style={{ fontSize: 12, color: C.txt3, lineHeight: 1.6 }}>
                  Écarter un bon terrain coûte l'opération entière ; garder un mauvais terrain coûte une étude.
                  Les seuils sont volontairement généreux — mais jetez quand même un œil ici avant de refermer.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {panH && (
        <PanneauH jeu={jeu} region={region} onSet={setH} onReset={resetH}
          onRegion={changerRegion} onResetAll={resetAllH} onClose={() => setPanH(false)} />
      )}
      {ajout && <Ajout onAdd={ajouter} onClose={() => setAjout(false)} />}
    </div>
  );
}
