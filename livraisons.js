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

const K = {
  livreurs: 'lgdm:tl:livreurs',
  tournees: 'lgdm:tl:tournees',
  index: 'lgdm:tl:index',
  indexLivreur: id => `lgdm:tl:index:livreur:${id}`,
  livree: id => `lgdm:tl:livree:${id}`,
  probleme: id => `lgdm:tl:probleme:${id}`,
  journal: id => `lgdm:tl:journal:${id}`,
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
    const r = await pipeline(tournees.flatMap(t => [['HGETALL', K.livree(t.id)], ['HGETALL', K.probleme(t.id)]]));
    return tournees.map((t, i) => ({ livrees: hashEnObjet(r[2 * i]), problemes: hashEnObjet(r[2 * i + 1]) }));
  }

  function vueArret(a, i, liv, pb) {
    return {
      ...a, numero: i + 1,
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
    const arrets = t.arrets.map((a, i) => vueArret(a, i, e.livrees[a.id], e.problemes[a.id]));
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
        statut: a.statut, livraison: a.livraison, probleme: a.probleme,
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
    const cmds = [['HDEL', K.tournees, t.id], ['ZREM', K.index, t.id], ['DEL', K.journal(t.id)]];
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
