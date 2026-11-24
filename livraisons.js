// ===========================================================================
//  Tournées de livraison : préparées à la brasserie, suivies par le livreur
// ===========================================================================
// La brasserie compose une tournée (nom, date, livreur, arrêts) et l'envoie au
// livreur par un lien privé. Le livreur ouvre ce lien sur son téléphone, part
// vers chaque client avec Waze et valide la livraison quand tout est conforme.
//
// Accès :
//   • l'équipe passe par sa session habituelle (routes /api/tournees-livraison) ;
//   • chaque livreur a un jeton personnel (routes /api/livreur/:jeton). Le
//     jeton ne donne accès qu'aux tournées qui lui sont attribuées ; une
//     tournée réattribuée disparaît aussitôt de l'ancien lien. Le jeton peut
//     être régénéré (téléphone perdu) ou le livreur désactivé.
//
// Stockage (Redis partagé, comme le reste de l'appli) :
//   lgdm:tl:livreurs            hash  id → livreur
//   lgdm:tl:tournees            hash  id → définition de la tournée (brasserie)
//   lgdm:tl:index               zset  id, score = jour de la tournée
//   lgdm:tl:index:livreur:<id>  zset  idem, par livreur
//   lgdm:tl:livree:<idT>        hash  idArret → validation (date, heure, livreur)
//   lgdm:tl:probleme:<idT>      hash  idArret → dernier problème signalé
//   lgdm:tl:journal:<idT>       liste des événements de livraison
//
// La définition (écrite par la brasserie) et l'état des arrêts (écrit par le
// livreur) sont séparés : réordonner une tournée pendant que le livreur
// valide ne peut pas effacer une validation. La validation passe par HSETNX,
// atomique côté Redis : deux validations simultanées (double appui, deux
// téléphones, renvoi après coupure) n'en enregistrent qu'une. Chaque envoi
// porte un identifiant d'opération : le renvoi d'une validation déjà
// enregistrée (réponse perdue en route) est reconnu et confirmé, pas refusé.

import crypto from 'crypto';
import fetch from 'node-fetch';
import PDFDocument from 'pdfkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Logo (blanc) pour l'en-tête sombre du rapport PDF ; facultatif.
let LOGO = null;
try { LOGO = readFileSync(fileURLToPath(new URL('./public/logo.png', import.meta.url))); } catch {}

const K = {
  livreurs: 'lgdm:tl:livreurs',
  tournees: 'lgdm:tl:tournees',
  index: 'lgdm:tl:index',
  indexLivreur: id => `lgdm:tl:index:livreur:${id}`,
  livree: id => `lgdm:tl:livree:${id}`,
  probleme: id => `lgdm:tl:probleme:${id}`,
  journal: id => `lgdm:tl:journal:${id}`,
  note: id => `lgdm:tl:note:${id}`,                    // hash idArret → note du livreur
  photos: id => `lgdm:tl:photos:${id}`,                // hash idPhoto → métadonnées
  photo: (id, p) => `lgdm:tl:photo:${id}:${p}`,        // image (base64), expire
};

export const MOTIFS = {
  client_absent: 'Client absent',
  livraison_partielle: 'Livraison partielle',
  adresse_incorrecte: 'Adresse incorrecte',
  refus: 'Livraison refusée',
  acces_impossible: 'Accès impossible',
  autre: 'Autre motif',
};

const MAX_ARRETS = 150;
const MAX_PHOTOS_ARRET = 3;
const MAX_PHOTO = 950_000;               // caractères base64 (≈ 700 Ko), sous la limite d'Upstash
const DUREE_PHOTO = 183 * 86400;         // 6 mois ; le rapport PDF les garde au-delà
const RE_PHOTO = /^p[a-f0-9]{20}$/;
const JOURS_ACTIVES = 60;        // au-delà, une tournée non close passe dans l'historique
const PAGE_HISTORIQUE = 40;

const jourParis = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const numeroJour = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000);
const nouvelId = prefixe => prefixe + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const ligne = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bloc = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
  .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const erreur = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const RE_ID = /^[A-Za-z0-9_-]{4,48}$/;
const RE_OPERATION = /^[A-Za-z0-9_-]{8,64}$/;
const RE_JETON = /^[A-Za-z0-9_-]{20,64}$/;
const heure = t => new Date(t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

// Redis renvoie un hash sous forme de liste plate [champ, valeur, champ, valeur…]
function hashEnObjet(plat) {
  const o = {};
  for (let i = 0; i + 1 < (plat?.length ?? 0); i += 2) {
    try { o[plat[i]] = JSON.parse(plat[i + 1]); } catch {}
  }
  return o;
}

// ---------------------------------------------------------------------------
//  Contrôle des adresses
// ---------------------------------------------------------------------------
// Deux niveaux : un contrôle de forme immédiat (code postal, numéro), puis la
// Base Adresse Nationale (Géoplateforme IGN, gratuite, sans clé) qui dit si
// l'adresse existe, où elle se trouve et si elle peut désigner plusieurs
// lieux. Seule une adresse reconnue sans ambiguïté reçoit des coordonnées :
// c'est elle qui sert de destination exacte dans Waze. Une adresse douteuse
// reste du texte, que Waze cherchera lui-même, et la brasserie est prévenue.

const VOIES = 'rue|r|av|ave|avenue|bd|boulevard|chemin|che|ch|route|rte|impasse|imp|all[ée]e|all|place|pl|quai|cours|lotissement|lot|r[ée]sidence|zone|za|zi|zac|faubourg|fg|passage|square|sq|voie|esplanade|promenade|rond-point|sentier|mont[ée]e|traverse|cit[ée]|hameau|lieu-dit|ld|parvis|port|parc|domaine|chemin';
const RE_NUMERO = new RegExp(`(^|[\\s,])\\d{1,4}\\s*(bis|ter|quater|[a-d])?\\s*,?\\s+(${VOIES})\\b`, 'i');
const RE_CP = /\b(0[1-9]|[1-8]\d|9[0-8])\d{3}\b/;
const RE_ZONE_EN_TETE = /^\s*(?:zac|za|zi|zae|zone|parc|centre commercial|c\.?\s?c\.?|lotissement|lot\.?|r[ée]sidence|b[aâ]timent|b[aâ]t\.?|immeuble|espace|p[oô]le|galerie)\b[^,]*,\s*(.{8,})$/i;

export function controleForme(adresse) {
  const a = ligne(adresse, 300);
  if (!a) return { niveau: 'erreur', message: 'Adresse manquante' };
  if (a.length < 8) return { niveau: 'erreur', message: 'Adresse incomplète' };
  const manque = [];
  if (!RE_CP.test(a)) manque.push('code postal');
  if (!RE_NUMERO.test(a) && !/^\s*\d/.test(a)) manque.push('numéro de rue');
  if (manque.length === 2) return { niveau: 'erreur', message: 'Adresse incomplète : ni code postal ni numéro de rue' };
  if (manque.length) return { niveau: 'avertissement', message: `Adresse incomplète : ${manque[0]} absent` };
  return { niveau: 'ok', message: '' };
}

const sansAccent = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const MOTS_VOIE = new Set(('rue avenue ave bd boulevard chemin che route rte impasse imp allee allees place quai cours lotissement lot '
  + 'residence zone faubourg passage square voie esplanade promenade sentier montee traverse cite hameau lieu dit parc domaine '
  + 'des les del dels de du la le bis ter quater sur sous saint sainte france').split(' '));

function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const geoCache = new Map();
async function geocoder(q) {
  const cle = sansAccent(q);
  const m = geoCache.get(cle);
  if (m && Date.now() < m.expire) return m.res;
  const enc = encodeURIComponent(q.slice(0, 200));
  const sources = [
    `https://data.geopf.fr/geocodage/search?q=${enc}&limit=5&index=address`,
    `https://api-adresse.data.gouv.fr/search/?q=${enc}&limit=5`,
  ];
  for (const url of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const d = await r.json();
      const res = (d.features ?? []).map(f => ({
        label: f.properties?.label ?? '', score: f.properties?.score ?? 0, type: f.properties?.type ?? '',
        city: f.properties?.city ?? '', citycode: f.properties?.citycode ?? '', postcode: f.properties?.postcode ?? '',
        housenumber: f.properties?.housenumber ?? '',
        lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0],
      })).filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng));
      geoCache.set(cle, { res, expire: Date.now() + 24 * 3600 * 1000 });
      if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value);
      return res;
    } catch {}
  }
  return null;   // service injoignable : ce n'est pas une adresse introuvable
}

export function analyserAdresse(adresse, resultats, depot) {
  const a = ligne(adresse, 300);
  const forme = controleForme(a);
  const base = { adresse: a, label: '', suggestion: '', lat: null, lng: null, score: null };
  // Incomplète dans sa forme : c'est le message le plus utile, quelle que
  // soit la réponse du service (qui proposera souvent une ville au hasard).
  if (forme.niveau === 'erreur') return { ...base, ...forme };
  if (resultats === null) {
    return { ...base, niveau: forme.niveau === 'ok' ? 'inconnu' : forme.niveau,
      message: forme.message || 'Vérification automatique indisponible : relisez l’adresse' };
  }
  const best = resultats[0];
  if (!best || best.score < 0.45) {
    return { ...base, niveau: 'erreur', message: 'Adresse introuvable : vérifiez la rue et la commune' };
  }
  const suggestion = sansAccent(best.label) !== sansAccent(a) ? best.label : '';
  const out = { ...base, label: best.label, suggestion, score: Math.round(best.score * 100) / 100 };

  const proches = resultats.filter(f => f.score >= best.score - 0.08);
  const communes = [...new Set(proches.map(f => f.citycode))];
  if (communes.length > 1) {
    const noms = [...new Set(proches.map(f => `${f.city} (${f.postcode})`))].slice(0, 3).join(', ');
    return { ...out, niveau: 'avertissement', message: `Adresse ambiguë : plusieurs communes possibles — ${noms}` };
  }
  if (best.type === 'municipality') {
    return { ...out, niveau: 'erreur', message: `Seule la commune est reconnue (${best.city}) : précisez la rue` };
  }
  // Le service renvoie toujours « quelque chose » : une rue voisine au nom
  // proche (rue de la Mairie → rue de la Hire) ne doit pas passer pour la bonne.
  const ville = new Set(sansAccent(best.city).split(' '));
  const mots = sansAccent(a.replace(RE_CP, ' ')).split(' ')
    .filter(m => m.length >= 3 && !/^\d+$/.test(m) && !MOTS_VOIE.has(m) && !ville.has(m));
  const label = ` ${sansAccent(best.label)} `;
  if (mots.length && mots.filter(m => label.includes(` ${m} `)).length / mots.length < 0.5) {
    return { ...out, niveau: 'avertissement', message: `Rue non reconnue${best.city ? ` à ${best.city}` : ''} : vérifiez l’orthographe` };
  }
  const cp = a.match(RE_CP)?.[0];
  if (cp && best.postcode && cp !== best.postcode) {
    return { ...out, niveau: 'avertissement', message: `Code postal à vérifier : ${best.postcode} trouvé pour cette adresse` };
  }
  if (forme.niveau !== 'ok' && best.type !== 'housenumber') {
    return { ...out, niveau: forme.niveau, message: forme.message };
  }
  if ((best.type === 'street' || best.type === 'locality') && /\d/.test(a.replace(RE_CP, ''))) {
    return { ...out, niveau: 'avertissement', message: 'Numéro introuvable : seule la rue est reconnue' };
  }
  if (best.score < 0.75) {
    return { ...out, niveau: 'avertissement', message: 'Adresse approximative : vérifiez la proposition' };
  }
  if (depot && distanceKm(depot, best) > 120) {
    return { ...out, niveau: 'avertissement',
      message: `Adresse à ${Math.round(distanceKm(depot, best))} km de la brasserie : vérifiez la commune` };
  }
  // Reconnue sans ambiguïté : seule cette issue fixe la destination exacte.
  return { ...out, niveau: 'ok', message: 'Adresse reconnue', lat: best.lat, lng: best.lng };
}

// ---------------------------------------------------------------------------
//  Montage des routes
// ---------------------------------------------------------------------------
export function monterLivraisons(app, { redis, pipeline, redisActif, depot }) {
  const repondre = (res, fn) => {
    res.set('Cache-Control', 'no-store');
    if (!redisActif()) return res.status(503).json({ error: 'Base partagée non configurée : les tournées ne peuvent pas être enregistrées.' });
    return fn().catch(err => {
      if (!err.status) console.error('livraisons:', err.message);
      res.status(err.status ?? 502).json({ error: err.status ? err.message : `Enregistrement impossible (${err.message})`, ...(err.extra ?? {}) });
    });
  };

  // --- Lectures -----------------------------------------------------------
  const lireJSON = async (cle, id) => { const v = await redis('HGET', cle, id); return v ? JSON.parse(v) : null; };
  const livreurs = async () => Object.values(hashEnObjet(await redis('HGETALL', K.livreurs)));

  async function tourneesParIds(ids) {
    if (!ids?.length) return [];
    const brut = await redis('HMGET', K.tournees, ...ids);
    return (brut ?? []).map(v => { try { return v ? JSON.parse(v) : null; } catch { return null; } }).filter(Boolean);
  }

  // États (validations, problèmes) de plusieurs tournées en un seul aller-retour
  async function etats(tournees) {
    if (!tournees.length) return [];
    const r = await pipeline(tournees.flatMap(t => [['HGETALL', K.livree(t.id)], ['HGETALL', K.probleme(t.id)],
      ['HGETALL', K.note(t.id)], ['HGETALL', K.photos(t.id)]]));
    return tournees.map((t, i) => ({ livrees: hashEnObjet(r[4 * i]), problemes: hashEnObjet(r[4 * i + 1]),
      notes: hashEnObjet(r[4 * i + 2]), photos: hashEnObjet(r[4 * i + 3]) }));
  }

  function vueArret(a, i, liv, pb, note = null, photos = []) {
    return {
      ...a, numero: i + 1,
      note: note ? { texte: note.texte, le: note.le, par: note.par?.nom ?? '' } : null,
      photos,
      statut: liv ? 'livree' : pb ? 'probleme' : 'a_livrer',
      livraison: liv ? { le: liv.le, par: liv.par?.nom ?? '' } : null,
      probleme: pb ? { motif: pb.motif, motifLibelle: MOTIFS[pb.motif] ?? pb.motif, commentaire: pb.commentaire,
        le: pb.le, par: pb.par?.nom ?? '' } : null,
    };
  }

  function statutTournee(t, s) {
    if (t.clotureeLe) return 'cloturee';
    if (!s.total) return 'vide';
    if (!s.aLivrer) return 'terminee';
    if (s.livrees + s.problemes) return 'en_cours';
    return 'a_venir';
  }

  function vueTournee(t, e, parId) {
    const photosPar = {};
    for (const [id, m] of Object.entries(e.photos ?? {})) (photosPar[m.idArret] ??= []).push({ id, le: m.le, par: m.par?.nom ?? '' });
    Object.values(photosPar).forEach(l => l.sort((a, b) => a.le - b.le));
    const arrets = t.arrets.map((a, i) => vueArret(a, i, e.livrees[a.id], e.problemes[a.id], e.notes?.[a.id], photosPar[a.id] ?? []));
    const stats = {
      total: arrets.length,
      livrees: arrets.filter(a => a.statut === 'livree').length,
      problemes: arrets.filter(a => a.statut === 'probleme').length,
    };
    stats.aLivrer = stats.total - stats.livrees - stats.problemes;
    const moments = arrets.flatMap(a => [a.livraison?.le, a.probleme?.le]).filter(Boolean);
    const l = parId.get(t.idLivreur);
    return {
      ...t, arrets, stats, statut: statutTournee(t, stats),
      derniereActivite: moments.length ? Math.max(...moments) : null,
      livreur: l ? { id: l.id, nom: l.nom, telephone: l.telephone, jeton: l.jeton, actif: l.actif } : null,
    };
  }

  const estHistorique = (v, aujourdhui) => v.statut === 'cloturee'
    || (v.statut === 'terminee' && v.date < aujourdhui)
    || numeroJour(v.date) < numeroJour(aujourdhui) - JOURS_ACTIVES;

  // --- Livreur : jeton → fiche ----------------------------------------------
  async function livreurDuJeton(jeton) {
    if (!RE_JETON.test(jeton ?? '')) throw erreur(404, 'Lien inconnu');
    const l = (await livreurs()).find(x => x.jeton === jeton);
    if (!l || !l.actif) throw erreur(404, 'Ce lien n’est plus actif. Demandez un nouveau lien à la brasserie.');
    return l;
  }
  async function tourneeDuLivreur(l, id) {
    const t = RE_ID.test(id ?? '') ? await lireJSON(K.tournees, id) : null;
    // Même réponse qu'une tournée inexistante : un lien ne révèle rien des
    // tournées des autres livreurs.
    if (!t || t.idLivreur !== l.id) throw erreur(404, 'Tournée introuvable ou attribuée à un autre livreur.');
    return t;
  }

  function vuePourLivreur(t, e) {
    const v = vueTournee(t, e, new Map());
    return {
      id: v.id, nom: v.nom, date: v.date, statut: v.statut, cloturee: !!v.clotureeLe, stats: v.stats,
      arrets: v.arrets.map(a => ({
        id: a.id, numero: a.numero, nom: a.nom, adresse: a.adresse, telephone: a.telephone, consignes: a.consignes,
        // Coordonnées seulement pour une adresse reconnue sans ambiguïté.
        lat: a.verif?.niveau === 'ok' ? a.lat ?? null : null,
        lng: a.verif?.niveau === 'ok' ? a.lng ?? null : null,
        statut: a.statut, livraison: a.livraison, probleme: a.probleme, note: a.note, photos: a.photos,
      })),
    };
  }

  // =========================================================================
  //  Côté livreur (accès par lien, sans session)
  // =========================================================================
  app.get('/api/livreur/:jeton', (req, res) => repondre(res, async () => {
    const l = await livreurDuJeton(req.params.jeton);
    const aujourdhui = jourParis();
    const ids = await redis('ZRANGEBYSCORE', K.indexLivreur(l.id), numeroJour(aujourdhui) - 7, '+inf');
    const ts = (await tourneesParIds(ids)).filter(t => t.idLivreur === l.id);
    const e = await etats(ts);
    const vues = ts.map((t, i) => vueTournee(t, e[i], new Map()))
      .map(v => ({ id: v.id, nom: v.nom, date: v.date, statut: v.statut, stats: v.stats }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.nom.localeCompare(b.nom, 'fr'));
    res.json({ livreur: { nom: l.nom }, aujourdhui, tournees: vues });
  }));

  app.get('/api/livreur/:jeton/tournee/:id', (req, res) => repondre(res, async () => {
    const l = await livreurDuJeton(req.params.jeton);
    const t = await tourneeDuLivreur(l, req.params.id);
    const [e] = await etats([t]);
    res.json({ livreur: { nom: l.nom }, tournee: vuePourLivreur(t, e), motifs: MOTIFS });
  }));

  async function preparerEcriture(req) {
    const l = await livreurDuJeton(req.params.jeton);
    const t = await tourneeDuLivreur(l, req.params.id);
    if (t.clotureeLe) throw erreur(409, 'Cette tournée a été clôturée par la brasserie : plus aucune modification possible.');
    const a = t.arrets.find(x => x.id === req.params.idArret);
    if (!a) throw erreur(404, 'Cet arrêt a été retiré de la tournée par la brasserie.');
    const operation = String(req.body?.operation ?? '');
    if (!RE_OPERATION.test(operation)) throw erreur(400, 'Requête incomplète : rechargez la page.');
    return { l, t, a, operation };
  }
  async function renvoyerArret(res, t, extra = {}) {
    const [e] = await etats([t]);
    const v = vuePourLivreur(t, e);
    res.json({ ok: true, ...extra, arret: v.arrets.find(x => x.id === extra.idArret), stats: v.stats });
  }

  app.post('/api/livreur/:jeton/tournee/:id/arret/:idArret/valider', (req, res) => repondre(res, async () => {
    const { l, t, a, operation } = await preparerEcriture(req);
    const validation = { le: Date.now(), par: { id: l.id, nom: l.nom }, operation };
    const pose = await redis('HSETNX', K.livree(t.id), a.id, JSON.stringify(validation));
    if (Number(pose) !== 1) {
      const existante = await lireJSON(K.livree(t.id), a.id);
      if (existante?.operation === operation) return renvoyerArret(res, t, { idArret: a.id, rejoue: true });
      const [e] = await etats([t]);
      throw erreur(409, `Livraison déjà validée à ${heure(existante?.le ?? Date.now())}${existante?.par?.nom ? ` par ${existante.par.nom}` : ''}.`,
        { arret: vuePourLivreur(t, e).arrets.find(x => x.id === a.id), dejaValidee: true });
    }
    await redis('RPUSH', K.journal(t.id), JSON.stringify({ type: 'livree', idArret: a.id, nom: a.nom, le: validation.le, par: l.nom }))
      .catch(err => console.error('livraisons: journal', err.message));   // la validation, elle, est acquise
    return renvoyerArret(res, t, { idArret: a.id });
  }));

  app.post('/api/livreur/:jeton/tournee/:id/arret/:idArret/probleme', (req, res) => repondre(res, async () => {
    const { l, t, a, operation } = await preparerEcriture(req);
    const motif = String(req.body?.motif ?? '');
    const commentaire = bloc(req.body?.commentaire, 1000);
    if (!MOTIFS[motif]) throw erreur(400, 'Choisissez le motif du problème.');
    if (commentaire.length < 3) throw erreur(400, 'Le commentaire est obligatoire : précisez ce qui s’est passé.');
    const deja = await lireJSON(K.livree(t.id), a.id);
    if (deja) throw erreur(409, `Livraison déjà validée à ${heure(deja.le)} : le problème n’a pas été enregistré. Prévenez la brasserie.`);
    const precedent = await lireJSON(K.probleme(t.id), a.id);
    if (precedent?.operation === operation) return renvoyerArret(res, t, { idArret: a.id, rejoue: true });
    const pb = { motif, commentaire, le: Date.now(), par: { id: l.id, nom: l.nom }, operation };
    await redis('HSET', K.probleme(t.id), a.id, JSON.stringify(pb));
    await redis('RPUSH', K.journal(t.id), JSON.stringify({ type: 'probleme', idArret: a.id, nom: a.nom, le: pb.le, par: l.nom,
      motif, commentaire })).catch(err => console.error('livraisons: journal', err.message));
    return renvoyerArret(res, t, { idArret: a.id });
  }));

  // Note libre du livreur sur un arrêt (accès, à qui c'est remis…). Texte
  // vide : la note est retirée. Modifiable jusqu'à la clôture de la tournée.
  app.post('/api/livreur/:jeton/tournee/:id/arret/:idArret/note', (req, res) => repondre(res, async () => {
    const { l, t, a, operation } = await preparerEcriture(req);
    const texte = bloc(req.body?.texte, 1000);
    const avant = await lireJSON(K.note(t.id), a.id);
    if (avant?.operation === operation) return renvoyerArret(res, t, { idArret: a.id, rejoue: true });
    if (!texte) {
      if (avant) {
        await redis('HDEL', K.note(t.id), a.id);
        await redis('RPUSH', K.journal(t.id), JSON.stringify({ type: 'note_supprimee', idArret: a.id, nom: a.nom, le: Date.now(), par: l.nom })).catch(() => {});
      }
    } else {
      const note = { texte, le: Date.now(), par: { id: l.id, nom: l.nom }, operation };
      await redis('HSET', K.note(t.id), a.id, JSON.stringify(note));
      await redis('RPUSH', K.journal(t.id), JSON.stringify({ type: 'note', idArret: a.id, nom: a.nom, le: note.le, par: l.nom, texte })).catch(() => {});
    }
    return renvoyerArret(res, t, { idArret: a.id });
  }));

  // Photo (preuve de dépôt quand personne ne peut signer). Compressée sur le
  // téléphone ; l'identifiant découle de l'opération, un renvoi ne la double pas.
  app.post('/api/livreur/:jeton/tournee/:id/arret/:idArret/photo', (req, res) => repondre(res, async () => {
    const { l, t, a, operation } = await preparerEcriture(req);
    const m = String(req.body?.image ?? '').match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!m) throw erreur(400, 'Photo illisible : reprenez-la.');
    if (m[2].length > MAX_PHOTO) throw erreur(413, 'Photo trop lourde : reprenez-la.');
    const idPhoto = 'p' + crypto.createHash('sha1').update(`${t.id}|${operation}`).digest('hex').slice(0, 20);
    const metas = hashEnObjet(await redis('HGETALL', K.photos(t.id)));
    if (metas[idPhoto]) return renvoyerArret(res, t, { idArret: a.id, idPhoto, rejoue: true });
    if (Object.values(metas).filter(x => x.idArret === a.id).length >= MAX_PHOTOS_ARRET) {
      throw erreur(409, `${MAX_PHOTOS_ARRET} photos au maximum par arrêt : supprimez-en une avant d’en ajouter.`);
    }
    await redis('SET', K.photo(t.id, idPhoto), m[2], 'EX', DUREE_PHOTO);
    const meta = { idArret: a.id, le: Date.now(), par: { id: l.id, nom: l.nom }, type: m[1], octets: Math.round(m[2].length * 0.75) };
    await redis('HSET', K.photos(t.id), idPhoto, JSON.stringify(meta));
    await redis('RPUSH', K.journal(t.id), JSON.stringify({ type: 'photo', idArret: a.id, nom: a.nom, le: meta.le, par: l.nom })).catch(() => {});
    return renvoyerArret(res, t, { idArret: a.id, idPhoto });
  }));

  app.delete('/api/livreur/:jeton/tournee/:id/arret/:idArret/photo/:idPhoto', (req, res) => repondre(res, async () => {
    const l = await livreurDuJeton(req.params.jeton);
    const t = await tourneeDuLivreur(l, req.params.id);
    if (t.clotureeLe) throw erreur(409, 'Tournée clôturée : la photo ne peut plus être retirée.');
    const meta = RE_PHOTO.test(req.params.idPhoto) ? await lireJSON(K.photos(t.id), req.params.idPhoto) : null;
    if (meta && meta.idArret === req.params.idArret) {
      await pipeline([['HDEL', K.photos(t.id), req.params.idPhoto], ['DEL', K.photo(t.id, req.params.idPhoto)],
        ['RPUSH', K.journal(t.id), JSON.stringify({ type: 'photo_supprimee', idArret: meta.idArret,
          nom: t.arrets.find(x => x.id === meta.idArret)?.nom ?? '', le: Date.now(), par: l.nom })]]);
    }
    return renvoyerArret(res, t, { idArret: req.params.idArret });
  }));

  async function envoyerPhoto(res, t, idPhoto) {
    const meta = RE_PHOTO.test(idPhoto ?? '') ? await lireJSON(K.photos(t.id), idPhoto) : null;
    const data = meta ? await redis('GET', K.photo(t.id, idPhoto)) : null;
    if (!data) throw erreur(404, 'Photo introuvable ou expirée');
    res.set('Content-Type', meta.type === 'png' ? 'image/png' : 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(data, 'base64'));
  }

  app.get('/api/livreur/:jeton/tournee/:id/photo/:idPhoto', (req, res) => repondre(res, async () => {
    const l = await livreurDuJeton(req.params.jeton);
    await envoyerPhoto(res, await tourneeDuLivreur(l, req.params.id), req.params.idPhoto);
  }));

  app.get('/api/livreur/:jeton/tournee/:id/rapport.pdf', (req, res) => repondre(res, async () => {
    const l = await livreurDuJeton(req.params.jeton);
    const t = await tourneeDuLivreur(l, req.params.id);
    const [e] = await etats([t]);
    await rapportPDF(res, vueTournee(t, e, new Map([[l.id, l]])), { inline: true });
  }));

  // =========================================================================
  //  Rapport PDF de la tournée
  // =========================================================================
  // Livraisons validées d'abord (heure, livreur, note, photos), puis problèmes
  // et arrêts non livrés. En-tête sombre aux couleurs de la brasserie, corps
  // clair pour l'impression.
  async function rapportPDF(res, v, { inline = false } = {}) {
    const ids = v.arrets.flatMap(a => a.photos.map(p => p.id));
    const brut = ids.length ? await pipeline(ids.map(id => ['GET', K.photo(v.id, id)])) : [];
    const images = new Map(ids.map((id, i) => [id, brut[i] ? Buffer.from(brut[i], 'base64') : null]));
    const net = s => String(s ?? '').replace(/[\u202f\u00a0]/g, ' ');
    const quand = t => net(new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }));
    const dateTournee = net(new Date(`${v.date}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }));
    const C = { orange: '#D97706', noir: '#0D0D0D', texte: '#1A1714', gris: '#6B6760', clair: '#F6F2EC', bord: '#E4DCCF',
      vert: '#15803D', vertClair: '#ECFDF3', rouge: '#B42318', rougeClair: '#FEF3F2' };
    const fichier = `tournee-${sansAccent(v.nom).replace(/\s+/g, '-').slice(0, 40) || 'livraisons'}-${v.date}.pdf`;

    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true,
      info: { Title: `Tournée ${v.nom} — ${v.date}`, Author: 'Le Gué des Moines' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fichier}"`);
    doc.pipe(res);
    const M = 40, W = doc.page.width, L = W - 2 * M, BAS = doc.page.height - 50;
    const besoin = h => { if (doc.y + h > BAS) { doc.addPage(); doc.y = M; } };

    // En-tête
    doc.rect(0, 0, W, 112).fill(C.noir);
    let x0 = M;
    if (LOGO) { try { doc.image(LOGO, M, 22, { fit: [58, 66] }); x0 = M + 74; } catch {} }
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.orange).text('RAPPORT DE TOURNÉE', x0, 28, { characterSpacing: 1.6 });
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#FFFFFF').text(net(v.nom).toUpperCase(), x0, 42, { width: W - x0 - M, height: 26, ellipsis: true });
    doc.font('Helvetica').fontSize(10).fillColor('#A8A39A')
      .text(`${dateTournee}  ·  Livreur : ${v.livreur?.nom ?? '—'}`, x0, 76, { width: W - x0 - M });

    // Chiffres clés
    const s = v.stats, y = 128, lc = (L - 20) / 3;
    [[`${s.livrees} / ${s.total}`, s.livrees > 1 ? 'livraisons validées' : 'livraison validée', C.vert],
     [String(s.problemes), s.problemes > 1 ? 'problèmes signalés' : 'problème signalé', s.problemes ? C.rouge : C.gris],
     [String(s.aLivrer), s.aLivrer > 1 ? 'arrêts non livrés' : 'arrêt non livré', s.aLivrer ? C.orange : C.gris]].forEach(([val, lib, col], k) => {
      const x = M + k * (lc + 10);
      doc.lineWidth(0.8).roundedRect(x, y, lc, 54, 10).fillAndStroke(C.clair, C.bord);
      doc.font('Helvetica-Bold').fontSize(20).fillColor(col).text(val, x + 14, y + 9, { width: lc - 28 });
      doc.font('Helvetica').fontSize(9).fillColor(C.gris).text(lib, x + 14, y + 35, { width: lc - 28 });
    });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.gris)
      .text(`Édité le ${quand(Date.now())}${v.clotureeLe ? '  ·  tournée clôturée' : s.aLivrer ? '  ·  tournée en cours' : ''}`, M, y + 64, { width: L });

    const titre = t => {
      besoin(70);
      doc.y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.orange).text(t.toUpperCase(), M, doc.y, { characterSpacing: 1.4 });
      doc.moveTo(M, doc.y + 3).lineTo(M + L, doc.y + 3).lineWidth(0.8).strokeColor(C.bord).stroke();
      doc.y += 12;
    };

    const encadre = (x, largeur, etiquette, texte, fond, couleur) => {
      doc.font('Helvetica').fontSize(9.5);
      const h = doc.heightOfString(net(texte), { width: largeur - 20 });
      const y0 = doc.y + 5;
      doc.roundedRect(x, y0, largeur, h + 24, 6).fill(fond);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(couleur).text(etiquette, x + 10, y0 + 6, { characterSpacing: 1 });
      doc.font('Helvetica').fontSize(9.5).fillColor(C.texte).text(net(texte), x + 10, y0 + 17, { width: largeur - 20 });
      doc.y = y0 + h + 24;
    };

    const blocArret = a => {
      const x = M + 40, lt = L - 40;
      doc.font('Helvetica').fontSize(9.5);
      const hTxt = t => t ? doc.heightOfString(net(t), { width: lt - 20 }) + 30 : 0;
      const hPhotos = a.photos.length ? 160 : 0;
      besoin(Math.min(64 + hTxt(a.note?.texte) + hTxt(a.probleme?.commentaire) + (a.consignes ? 16 : 0) + hPhotos, BAS - M));
      const y0 = doc.y;
      const col = a.statut === 'livree' ? C.vert : a.statut === 'probleme' ? C.rouge : C.orange;
      doc.lineWidth(1.2).circle(M + 13, y0 + 12, 12).fillAndStroke(a.statut === 'livree' ? C.vertClair : a.statut === 'probleme' ? C.rougeClair : C.clair, col);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(col).text(String(a.numero), M + 1, y0 + 7, { width: 24, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.texte).text(net(a.nom), x, y0, { width: lt });
      doc.font('Helvetica').fontSize(9.5).fillColor(C.gris).text(net([a.adresse, a.telephone].filter(Boolean).join('   ·   ')) || 'Adresse non renseignée', x, doc.y + 1, { width: lt });
      const statut = a.statut === 'livree' ? `Validée le ${quand(a.livraison.le)}${a.livraison.par ? ` par ${a.livraison.par}` : ''}`
        : a.statut === 'probleme' ? `Problème signalé le ${quand(a.probleme.le)}${a.probleme.par ? ` par ${a.probleme.par}` : ''} : ${a.probleme.motifLibelle}`
        : 'Non livrée';
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(col).text(net(statut), x, doc.y + 4, { width: lt });
      if (a.probleme && a.statut === 'probleme') encadre(x, lt, 'COMMENTAIRE DU LIVREUR', a.probleme.commentaire, C.rougeClair, C.rouge);
      if (a.probleme && a.statut === 'livree') {
        doc.font('Helvetica').fontSize(8.5).fillColor(C.gris)
          .text(net(`Problème signalé auparavant (${quand(a.probleme.le)}) : ${a.probleme.motifLibelle} — ${a.probleme.commentaire}`), x, doc.y + 3, { width: lt });
      }
      if (a.note) encadre(x, lt, `NOTE DU LIVREUR  ·  ${quand(a.note.le)}`, a.note.texte, C.clair, C.orange);
      if (a.consignes) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.gris).text(net(`Consignes : ${a.consignes.replace(/\n+/g, ' · ')}`), x, doc.y + 4, { width: lt });
      }
      if (a.photos.length) {
        const bw = (lt - 2 * 8) / 3, bh = 130, py = doc.y + 8;
        a.photos.slice(0, 3).forEach((p, k) => {
          const px = x + k * (bw + 8);
          const img = images.get(p.id);
          doc.lineWidth(0.6).roundedRect(px, py, bw, bh, 4).fillAndStroke(C.clair, C.bord);
          let ok = false;
          if (img) { try { doc.image(img, px + 2, py + 2, { fit: [bw - 4, bh - 4], align: 'center', valign: 'center' }); ok = true; } catch {} }
          if (!ok) doc.font('Helvetica').fontSize(8.5).fillColor(C.gris).text('Photo expirée ou illisible', px, py + bh / 2 - 5, { width: bw, align: 'center' });
          doc.font('Helvetica').fontSize(7.5).fillColor(C.gris).text(net(`Photo ${k + 1}  ·  ${quand(p.le)}`), px, py + bh + 4, { width: bw, align: 'center' });
        });
        doc.y = py + bh + 18;
      }
      doc.y += 8;
      doc.moveTo(x, doc.y).lineTo(M + L, doc.y).lineWidth(0.5).strokeColor(C.bord).stroke();
      doc.y += 12;
    };

    doc.y = y + 82;
    const groupes = [
      ['Livraisons validées', v.arrets.filter(a => a.statut === 'livree')],
      ['Problèmes signalés', v.arrets.filter(a => a.statut === 'probleme')],
      ['Arrêts non livrés', v.arrets.filter(a => a.statut === 'a_livrer')],
    ];
    for (const [t, liste] of groupes) {
      if (!liste.length && t !== 'Livraisons validées') continue;
      titre(`${t} (${liste.length})`);
      if (!liste.length) doc.font('Helvetica').fontSize(10).fillColor(C.gris).text('Aucune livraison validée pour l’instant.', M, doc.y);
      liste.forEach(blocArret);
    }

    // Pied de page
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const marge = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gris)
        .text(net(`Le Gué des Moines — Bruguières   ·   ${v.nom}   ·   ${dateTournee}   ·   page ${i + 1} / ${pages.count}`),
          M, doc.page.height - 28, { width: L, align: 'center', lineBreak: false });
      doc.page.margins.bottom = marge;
    }
    doc.end();
  }

  // =========================================================================
  //  Côté brasserie (session d'équipe)
  // =========================================================================
  const B = '/api/tournees-livraison';

  // --- Livreurs -------------------------------------------------------------
  app.get(`${B}/livreurs`, (req, res) => repondre(res, async () => {
    res.json((await livreurs()).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')));
  }));

  app.post(`${B}/livreurs`, (req, res) => repondre(res, async () => {
    const nom = ligne(req.body?.nom, 80);
    if (!nom) throw erreur(400, 'Nom du livreur requis');
    const l = { id: nouvelId('l'), nom, telephone: ligne(req.body?.telephone, 40),
      jeton: crypto.randomBytes(18).toString('base64url'), actif: true, creeLe: Date.now() };
    await redis('HSET', K.livreurs, l.id, JSON.stringify(l));
    res.json(l);
  }));

  app.put(`${B}/livreurs/:id`, (req, res) => repondre(res, async () => {
    const l = RE_ID.test(req.params.id) ? await lireJSON(K.livreurs, req.params.id) : null;
    if (!l) throw erreur(404, 'Livreur inconnu');
    const maj = { ...l,
      nom: req.body?.nom !== undefined ? ligne(req.body.nom, 80) || l.nom : l.nom,
      telephone: req.body?.telephone !== undefined ? ligne(req.body.telephone, 40) : l.telephone,
      actif: typeof req.body?.actif === 'boolean' ? req.body.actif : l.actif };
    await redis('HSET', K.livreurs, l.id, JSON.stringify(maj));
    res.json(maj);
  }));

  // Nouveau lien : l'ancien cesse aussitôt de fonctionner (téléphone perdu…)
  app.post(`${B}/livreurs/:id/regenerer`, (req, res) => repondre(res, async () => {
    const l = RE_ID.test(req.params.id) ? await lireJSON(K.livreurs, req.params.id) : null;
    if (!l) throw erreur(404, 'Livreur inconnu');
    const maj = { ...l, jeton: crypto.randomBytes(18).toString('base64url'), regenereLe: Date.now() };
    await redis('HSET', K.livreurs, l.id, JSON.stringify(maj));
    res.json(maj);
  }));

  // --- Vérification d'adresses ---------------------------------------------
  app.post(`${B}/verifier-adresses`, (req, res) => repondre(res, async () => {
    const adresses = (Array.isArray(req.body?.adresses) ? req.body.adresses : []).slice(0, MAX_ARRETS).map(a => ligne(a, 300));
    const resultats = new Array(adresses.length);
    let i = 0;
    // 5 requêtes à la fois : le service public tolère 50 requêtes/s par IP.
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (i < adresses.length) {
        const k = i++;
        const a = adresses[k];
        const geo = a.length >= 8 ? await geocoder(a) : [];
        let r = analyserAdresse(a, geo, depot);
        // « ZAC de la Gravette, 1 rue de la Gravette… » : le nom de zone placé
        // en tête trouble la recherche. On vérifie aussi l'adresse sans lui ;
        // reconnue, elle donne la destination exacte et l'adresse saisie (avec
        // la zone, utile au livreur) est conservée telle quelle.
        const zone = a.match(RE_ZONE_EN_TETE);
        if (r.niveau !== 'ok' && zone) {
          const sans = analyserAdresse(zone[1], await geocoder(zone[1]), depot);
          if (sans.niveau === 'ok') r = { ...sans, adresse: a, suggestion: '', message: 'Adresse reconnue' };
        }
        resultats[k] = r;
      }
    }));
    res.json({ resultats });
  }));

  // --- Tournées ---------------------------------------------------------------
  function nettoyerArrets(liste) {
    if (!Array.isArray(liste)) throw erreur(400, 'Liste d’arrêts invalide');
    if (liste.length > MAX_ARRETS) throw erreur(400, `${MAX_ARRETS} arrêts au maximum par tournée`);
    const vus = new Set();
    return liste.map(a => {
      const nom = ligne(a?.nom, 120);
      const adresse = ligne(a?.adresse, 300);
      if (!nom && !adresse) return null;
      let id = RE_ID.test(a?.id ?? '') ? a.id : null;
      if (!id || vus.has(id)) id = nouvelId('a');
      vus.add(id);
      const arret = { id, nom: nom || adresse, adresse, telephone: ligne(a?.telephone, 40), consignes: bloc(a?.consignes, 1000) };
      // Le résultat de vérification (et les coordonnées qui en découlent) ne
      // vaut que pour l'adresse vérifiée : modifiée depuis, il est oublié.
      const v = a?.verif;
      if (v && ['ok', 'avertissement', 'erreur', 'inconnu'].includes(v.niveau) && ligne(v.adresse, 300) === adresse) {
        arret.verif = { niveau: v.niveau, message: ligne(v.message, 200), suggestion: ligne(v.suggestion, 300), adresse };
        const lat = Number(a.lat), lng = Number(a.lng);
        if (v.niveau === 'ok' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          arret.lat = lat; arret.lng = lng;
        }
      }
      return arret;
    }).filter(Boolean);
  }

  function lireEntete(body, livreursConnus) {
    const nom = ligne(body?.nom, 120);
    const date = String(body?.date ?? '');
    if (!nom) throw erreur(400, 'Donnez un nom à la tournée');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw erreur(400, 'Date de tournée invalide');
    const idLivreur = body?.idLivreur ? String(body.idLivreur) : null;
    if (idLivreur && !livreursConnus.some(l => l.id === idLivreur)) throw erreur(400, 'Livreur inconnu');
    return { nom, date, idLivreur };
  }

  async function indexer(t, ancien) {
    const cmds = [['ZADD', K.index, numeroJour(t.date), t.id]];
    if (ancien?.idLivreur && ancien.idLivreur !== t.idLivreur) cmds.push(['ZREM', K.indexLivreur(ancien.idLivreur), t.id]);
    if (t.idLivreur) cmds.push(['ZADD', K.indexLivreur(t.idLivreur), numeroJour(t.date), t.id]);
    await pipeline(cmds);
  }

  async function detail(t) {
    const [e] = await etats([t]);
    const parId = new Map((await livreurs()).map(l => [l.id, l]));
    const journal = ((await redis('LRANGE', K.journal(t.id), -500, -1)) ?? [])
      .map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    return { ...vueTournee(t, e, parId), journal };
  }

  const lireTournee = async id => {
    const t = RE_ID.test(id ?? '') ? await lireJSON(K.tournees, id) : null;
    if (!t) throw erreur(404, 'Tournée introuvable');
    return t;
  };

  app.get(B, (req, res) => repondre(res, async () => {
    const aujourdhui = jourParis();
    const historique = req.query.vue === 'historique';
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    let ids, suite = false;
    if (historique) {
      ids = await redis('ZREVRANGE', K.index, page * PAGE_HISTORIQUE, (page + 1) * PAGE_HISTORIQUE);
      suite = ids.length > PAGE_HISTORIQUE;
      ids = ids.slice(0, PAGE_HISTORIQUE);
    } else {
      ids = await redis('ZRANGEBYSCORE', K.index, numeroJour(aujourdhui) - JOURS_ACTIVES, '+inf');
    }
    const ls = await livreurs();
    const parId = new Map(ls.map(l => [l.id, l]));
    const ts = await tourneesParIds(ids);
    const e = await etats(ts);
    const vues = ts.map((t, i) => vueTournee(t, e[i], parId))
      .filter(v => estHistorique(v, aujourdhui) === historique)
      .sort((a, b) => historique ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date) || a.creeLe - b.creeLe);
    res.json({ aujourdhui, tournees: vues, suite, livreurs: ls.sort((a, b) => a.nom.localeCompare(b.nom, 'fr')) });
  }));

  app.get(`${B}/:id`, (req, res) => repondre(res, async () => {
    res.json(await detail(await lireTournee(req.params.id)));
  }));

  app.get(`${B}/:id/photos/:idPhoto`, (req, res) => repondre(res, async () => {
    await envoyerPhoto(res, await lireTournee(req.params.id), req.params.idPhoto);
  }));

  app.get(`${B}/:id/rapport.pdf`, (req, res) => repondre(res, async () => {
    const t = await lireTournee(req.params.id);
    const [e] = await etats([t]);
    const parId = new Map((await livreurs()).map(l => [l.id, l]));
    await rapportPDF(res, vueTournee(t, e, parId), { inline: req.query.voir === '1' });
  }));

  app.post(B, (req, res) => repondre(res, async () => {
    const ls = await livreurs();
    const t = { id: nouvelId('t'), ...lireEntete(req.body, ls), arrets: nettoyerArrets(req.body?.arrets ?? []),
      creeLe: Date.now(), modifieLe: Date.now(), version: 1, clotureeLe: null };
    await redis('HSET', K.tournees, t.id, JSON.stringify(t));
    await indexer(t);
    res.json(await detail(t));
  }));

  app.put(`${B}/:id`, (req, res) => repondre(res, async () => {
    const t = await lireTournee(req.params.id);
    if (t.clotureeLe) throw erreur(409, 'Tournée clôturée : rouvrez-la pour la modifier.');
    if (Number(req.body?.version) !== t.version) {
      throw erreur(409, 'Cette tournée vient d’être modifiée par un collègue : vos changements n’ont pas été enregistrés. Rechargez-la.',
        { conflit: true });
    }
    const ls = await livreurs();
    const entete = lireEntete(req.body, ls);
    const arrets = nettoyerArrets(req.body?.arrets ?? []);
    const [e] = await etats([t]);
    const gardes = new Set(arrets.map(a => a.id));
    const retiresLivres = t.arrets.filter(a => !gardes.has(a.id) && e.livrees[a.id]);
    if (retiresLivres.length) {
      throw erreur(409, `« ${retiresLivres[0].nom} » est déjà livré : remettez-le « à livrer » avant de le retirer de la tournée.`);
    }
    const maj = { ...t, ...entete, arrets, modifieLe: Date.now(), version: t.version + 1 };
    await redis('HSET', K.tournees, t.id, JSON.stringify(maj));
    await indexer(maj, t);
    res.json(await detail(maj));
  }));

  app.delete(`${B}/:id`, (req, res) => repondre(res, async () => {
    const t = await lireTournee(req.params.id);
    const [e] = await etats([t]);
    if (Object.keys(e.livrees).length || Object.keys(e.problemes).length) {
      throw erreur(409, 'Des livraisons sont déjà enregistrées sur cette tournée : clôturez-la plutôt, pour garder l’historique.');
    }
    const cmds = [['HDEL', K.tournees, t.id], ['ZREM', K.index, t.id], ['DEL', K.journal(t.id)], ['DEL', K.note(t.id)],
      ['DEL', K.photos(t.id)], ...Object.keys(e.photos ?? {}).map(p => ['DEL', K.photo(t.id, p)])];
    if (t.idLivreur) cmds.push(['ZREM', K.indexLivreur(t.idLivreur), t.id]);
    await pipeline(cmds);
    res.json({ ok: true });
  }));

  async function changer(req, fn, evenement) {
    const t = await lireTournee(req.params.id);
    const maj = fn(t);
    await redis('HSET', K.tournees, t.id, JSON.stringify({ ...maj, modifieLe: Date.now(), version: t.version + 1 }));
    if (evenement) await redis('RPUSH', K.journal(t.id), JSON.stringify({ ...evenement, le: Date.now(), par: 'Brasserie' })).catch(() => {});
    return detail(await lireTournee(t.id));
  }

  app.post(`${B}/:id/cloturer`, (req, res) => repondre(res, async () => {
    res.json(await changer(req, t => ({ ...t, clotureeLe: t.clotureeLe ?? Date.now() }), { type: 'cloturee' }));
  }));
  app.post(`${B}/:id/rouvrir`, (req, res) => repondre(res, async () => {
    res.json(await changer(req, t => ({ ...t, clotureeLe: null }), { type: 'rouverte' }));
  }));
  // Trace du dernier envoi du lien au livreur (affichée dans le suivi)
  app.post(`${B}/:id/partage`, (req, res) => repondre(res, async () => {
    const t = await lireTournee(req.params.id);
    const maj = { ...t, partageeLe: Date.now() };
    await redis('HSET', K.tournees, t.id, JSON.stringify(maj));
    res.json({ ok: true, partageeLe: maj.partageeLe });
  }));

  // Tournée récurrente : mêmes arrêts, nouvelle date, aucun statut repris.
  app.post(`${B}/:id/dupliquer`, (req, res) => repondre(res, async () => {
    const src = await lireTournee(req.params.id);
    const ls = await livreurs();
    const entete = lireEntete({ nom: req.body?.nom ?? src.nom, date: req.body?.date, idLivreur: src.idLivreur }, ls);
    const t = { id: nouvelId('t'), ...entete,
      arrets: src.arrets.map(a => ({ ...a, id: nouvelId('a') })),
      creeLe: Date.now(), modifieLe: Date.now(), version: 1, clotureeLe: null };
    await redis('HSET', K.tournees, t.id, JSON.stringify(t));
    await indexer(t);
    res.json(await detail(t));
  }));

  // Correction par la brasserie (validation par erreur, problème réglé…)
  app.post(`${B}/:id/arrets/:idArret/reinitialiser`, (req, res) => repondre(res, async () => {
    const t = await lireTournee(req.params.id);
    if (t.clotureeLe) throw erreur(409, 'Tournée clôturée : rouvrez-la pour corriger un arrêt.');
    const a = t.arrets.find(x => x.id === req.params.idArret);
    if (!a) throw erreur(404, 'Arrêt inconnu');
    await pipeline([['HDEL', K.livree(t.id), a.id], ['HDEL', K.probleme(t.id), a.id],
      ['RPUSH', K.journal(t.id), JSON.stringify({ type: 'reinitialise', idArret: a.id, nom: a.nom, le: Date.now(), par: 'Brasserie' })]]);
    res.json(await detail(t));
  }));
}
