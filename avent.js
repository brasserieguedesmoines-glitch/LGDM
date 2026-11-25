// ===========================================================================
//  Calendrier de l'Avent du Gué : un cadeau par semaine, tiré au sort
// ===========================================================================
// Chaque semaine de l'Avent, un client fidèle venu boire un coup à la
// brasserie cette semaine-là gagne le cadeau de la semaine.
//
//   • Les participants viennent de l'export de la carte de fidélité (tampons
//     datés), d'une liste collée ou d'un ajout à la main. Le navigateur lit le
//     fichier et range chaque passage dans la bonne semaine ; le serveur ne
//     reçoit que la liste nettoyée.
//   • Le tirage se fait ICI, côté serveur (crypto.randomInt), jamais dans le
//     navigateur : l'animation affichée au bar ne fait que révéler un résultat
//     déjà enregistré. Un tirage ne se relance pas en douce : refaire un
//     tirage exige un motif (gagnant injoignable…) et l'ancien résultat reste
//     dans l'historique de la semaine.
//   • Une fois la semaine tirée, sa liste de participants est figée.
//
// Stockage (Redis partagé, comme le reste de l'appli) :
//   lgdm:avent:<année>   hash  reglages → règles du jeu, s1…s8 → semaines
//   lgdm:avent:verrou:<année>:<id>   verrou de 15 s pendant un tirage

import crypto from 'crypto';

const cleAnnee = a => `lgdm:avent:${a}`;
const cleVerrou = (a, id) => `lgdm:avent:verrou:${a}:${id}`;

const MAX_SEMAINES = 8;
const MAX_PARTICIPANTS = 3000;
const MAX_HISTORIQUE = 20;
const RE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
const RE_SEMAINE = /^s[1-8]$/;
const STATUTS_REMISE = ['a_prevenir', 'prevenu', 'remis'];
export const MOTIFS_RETIRAGE = {
  injoignable: 'Gagnant injoignable',
  refus: 'Gagnant qui refuse le cadeau',
  conditions: 'Ne remplit pas les conditions (équipe, mineur…)',
  erreur: 'Erreur dans la liste des participants',
  autre: 'Autre motif',
};

const ligne = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const erreur = (status, message) => Object.assign(new Error(message), { status });
const jourParis = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const ajouterJours = (jour, n) => {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sansAccent = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Une même personne doit être reconnue d'une semaine à l'autre (pour ne pas
// gagner deux fois) et d'un import à l'autre : téléphone d'abord (le plus
// stable), puis e-mail, puis nom. Même calcul dans avent.js côté navigateur.
export function clePersonne({ tel, email, nom }) {
  const chiffres = String(tel ?? '').replace(/\D/g, '');
  if (chiffres.length >= 9) return 't' + chiffres.slice(-9);
  const mail = String(email ?? '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+$/.test(mail)) return 'm' + mail;
  const n = sansAccent(nom).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ');
  return n ? 'n' + n : '';
}

// Semaines par défaut : du lundi de la semaine du 1er décembre jusqu'au
// 24 décembre, une porte par semaine (lundi → dimanche, la dernière s'arrête
// le 24). En 2026 : 30/11, 7/12, 14/12, 21/12 → quatre portes.
function semainesParDefaut(annee) {
  const premier = new Date(Date.UTC(annee, 11, 1, 12));
  const decalage = (premier.getUTCDay() + 6) % 7;            // lundi = 0
  let debut = ajouterJours(`${annee}-12-01`, -decalage);
  const veille = `${annee}-12-24`;
  const semaines = [];
  while (debut <= veille && semaines.length < MAX_SEMAINES) {
    const fin = ajouterJours(debut, 6) < veille ? ajouterJours(debut, 6) : veille;
    semaines.push(semaineVide(`s${semaines.length + 1}`, debut, fin));
    debut = ajouterJours(debut, 7);
  }
  return semaines;
}
const semaineVide = (id, debut, fin) => ({
  id, numero: Number(id.slice(1)), debut, fin, cadeau: '',
  participants: [], imports: [], tirage: null, historique: [], maj: 0,
});
const REGLAGES_DEFAUT = { exclureGagnants: true, chances: 'personne' };

function nettoyerParticipant(p) {
  const nom = ligne(p?.nom, 80);
  const tel = ligne(p?.tel, 30);
  const email = ligne(p?.email, 120).toLowerCase();
  const cle = clePersonne({ tel, email, nom });
  if (!cle || !nom) return null;
  const jours = [...new Set((Array.isArray(p?.jours) ? p.jours : []).filter(j => RE_JOUR.test(j)))].sort().slice(0, 14);
  return {
    cle, nom, tel, email, jours,
    passages: Math.max(1, Math.min(50, Math.round(Number(p?.passages) || jours.length || 1))),
    manuel: !!p?.manuel,
    exclu: !!p?.exclu,
  };
}

export function monterAvent(app, { redis, redisActif }) {
  const repondre = (res, fn) => {
    res.set('Cache-Control', 'no-store');
    if (!redisActif()) return res.status(503).json({ error: 'Base partagée non configurée : le calendrier ne peut pas être enregistré.' });
    return fn().catch(err => {
      if (!err.status) console.error('avent:', err.message);
      res.status(err.status ?? 502).json({ error: err.status ? err.message : `Enregistrement impossible (${err.message})` });
    });
  };

  const lireAnnee = req => {
    const a = Number(req.params.annee ?? req.query.annee ?? jourParis().slice(0, 4));
    if (!Number.isInteger(a) || a < 2024 || a > 2100) throw erreur(400, 'Année invalide');
    return a;
  };

  // Calendrier complet : ce qui est enregistré, complété par les valeurs par
  // défaut (rien n'est écrit tant que personne n'a rien modifié).
  async function calendrier(annee) {
    const plat = await redis('HGETALL', cleAnnee(annee)) ?? [];
    const brut = {};
    for (let i = 0; i + 1 < plat.length; i += 2) { try { brut[plat[i]] = JSON.parse(plat[i + 1]); } catch {} }
    const reglages = { ...REGLAGES_DEFAUT, ...(brut.reglages ?? {}) };
    const defauts = semainesParDefaut(annee);
    const ids = new Set([...defauts.map(s => s.id), ...Object.keys(brut).filter(k => RE_SEMAINE.test(k))]);
    const semaines = [...ids].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))
      .map(id => brut[id] ?? defauts.find(s => s.id === id))
      .filter(Boolean);
    return { annee, reglages, semaines };
  }
  async function semaine(annee, id) {
    if (!RE_SEMAINE.test(id)) throw erreur(404, 'Semaine inconnue');
    const cal = await calendrier(annee);
    const s = cal.semaines.find(x => x.id === id);
    if (!s) throw erreur(404, 'Semaine inconnue');
    return { cal, s };
  }
  const enregistrer = (annee, s) => {
    s.maj = Date.now();
    const v = JSON.stringify(s);
    if (v.length > 900_000) throw erreur(413, 'Liste de participants trop volumineuse');
    return redis('HSET', cleAnnee(annee), s.id, v);
  };

  const B = '/api/avent';

  app.get(B, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    res.json({ ...(await calendrier(annee)), aujourdhui: jourParis(), motifs: MOTIFS_RETIRAGE });
  }));

  // Règles du jeu
  app.put(`${B}/:annee/reglages`, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    const { reglages } = await calendrier(annee);
    if (typeof req.body?.exclureGagnants === 'boolean') reglages.exclureGagnants = req.body.exclureGagnants;
    if (['personne', 'passage'].includes(req.body?.chances)) reglages.chances = req.body.chances;
    await redis('HSET', cleAnnee(annee), 'reglages', JSON.stringify(reglages));
    res.json(reglages);
  }));

  // Cadeau et dates d'une semaine (dates figées une fois la semaine tirée)
  app.put(`${B}/:annee/semaines/:id`, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    const { s } = await semaine(annee, req.params.id);
    if (req.body?.cadeau !== undefined) s.cadeau = ligne(req.body.cadeau, 160);
    const { debut, fin } = req.body ?? {};
    if (debut !== undefined || fin !== undefined) {
      if (s.tirage) throw erreur(409, 'Semaine déjà tirée : ses dates ne changent plus.');
      const d = debut ?? s.debut, f = fin ?? s.fin;
      if (!RE_JOUR.test(d) || !RE_JOUR.test(f) || d > f) throw erreur(400, 'Dates invalides');
      s.debut = d; s.fin = f;
    }
    await enregistrer(annee, s);
    res.json(s);
  }));

  // Liste des participants (remplacée en entier ; figée une fois tirée)
  app.put(`${B}/:annee/semaines/:id/participants`, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    const { s } = await semaine(annee, req.params.id);
    if (s.tirage) throw erreur(409, 'Semaine déjà tirée : la liste des participants est figée.');
    const brut = Array.isArray(req.body?.participants) ? req.body.participants : null;
    if (!brut) throw erreur(400, 'Liste de participants attendue');
    if (brut.length > MAX_PARTICIPANTS) throw erreur(413, `Au plus ${MAX_PARTICIPANTS} participants par semaine`);
    const parCle = new Map();
    for (const p of brut) {
      const n = nettoyerParticipant(p);
      if (!n) continue;
      const deja = parCle.get(n.cle);
      if (!deja) { parCle.set(n.cle, n); continue; }
      // Doublon : on fusionne plutôt que d'écraser
      deja.jours = [...new Set([...deja.jours, ...n.jours])].sort();
      deja.passages = Math.max(deja.passages, n.passages, deja.jours.length);
      deja.tel ||= n.tel; deja.email ||= n.email;
      deja.exclu ||= n.exclu;
    }
    s.participants = [...parCle.values()];
    const imp = req.body?.import;
    if (imp) {
      s.imports = [...(s.imports ?? []), {
        le: Date.now(), source: ligne(imp.source, 120) || 'Import',
        ajoutes: Math.max(0, Math.round(Number(imp.ajoutes) || 0)),
      }].slice(-10);
    }
    await enregistrer(annee, s);
    res.json(s);
  }));

  // Le tirage au sort
  app.post(`${B}/:annee/semaines/:id/tirage`, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    const id = req.params.id;
    // Verrou : un double appui ou deux téléphones en même temps ne
    // produisent jamais deux tirages.
    const pris = await redis('SET', cleVerrou(annee, id), '1', 'NX', 'EX', 15);
    if (pris !== 'OK') throw erreur(409, 'Un tirage est déjà en cours pour cette semaine.');
    try {
      const { cal, s } = await semaine(annee, id);
      const motif = req.body?.motif;
      if (s.tirage) {
        if (!MOTIFS_RETIRAGE[motif]) throw erreur(409, 'Cette semaine est déjà tirée. Un nouveau tirage demande un motif.');
        s.historique = [...(s.historique ?? []), {
          ...s.tirage, annuleLe: Date.now(), motif, motifLibelle: MOTIFS_RETIRAGE[motif],
          precision: ligne(req.body?.precision, 200),
        }].slice(-MAX_HISTORIQUE);
      }
      const gagnantsAutres = cal.reglages.exclureGagnants
        ? new Set(cal.semaines.filter(x => x.id !== s.id && x.tirage).map(x => x.tirage.gagnant.cle))
        : new Set();
      const dejaTires = new Set((s.historique ?? []).map(h => h.gagnant.cle));
      const eligibles = s.participants.filter(p => !p.exclu && !gagnantsAutres.has(p.cle) && !dejaTires.has(p.cle));
      if (!eligibles.length) throw erreur(409, 'Aucun participant éligible pour cette semaine.');

      const parPassage = cal.reglages.chances === 'passage';
      const poids = eligibles.map(p => parPassage ? Math.max(1, p.passages) : 1);
      const total = poids.reduce((a, b) => a + b, 0);
      let r = crypto.randomInt(total);
      let i = 0;
      while (r >= poids[i]) { r -= poids[i]; i++; }
      const g = eligibles[i];

      s.tirage = {
        gagnant: { cle: g.cle, nom: g.nom, tel: g.tel, email: g.email, passages: g.passages, jours: g.jours },
        le: Date.now(),
        nbParticipants: s.participants.length,
        nbEligibles: eligibles.length,
        nbChances: total,
        chances: parPassage ? 'passage' : 'personne',
        exclusGagnants: s.participants.filter(p => gagnantsAutres.has(p.cle)).length,
        // Empreinte de la liste tirée : prouve après coup qu'elle n'a pas bougé.
        empreinte: crypto.createHash('sha256').update(eligibles.map(p => p.cle).sort().join('|')).digest('hex').slice(0, 16),
        statut: 'a_prevenir',
        note: '',
      };
      await enregistrer(annee, s);
      res.json(s);
    } finally {
      await redis('DEL', cleVerrou(annee, id)).catch(() => {});
    }
  }));

  // Suivi du gagnant : prévenu, cadeau remis
  app.put(`${B}/:annee/semaines/:id/remise`, (req, res) => repondre(res, async () => {
    const annee = lireAnnee(req);
    const { s } = await semaine(annee, req.params.id);
    if (!s.tirage) throw erreur(409, 'Aucun gagnant pour cette semaine.');
    if (req.body?.statut !== undefined) {
      if (!STATUTS_REMISE.includes(req.body.statut)) throw erreur(400, 'Statut inconnu');
      s.tirage.statut = req.body.statut;
      s.tirage[`${req.body.statut}Le`] = Date.now();
    }
    if (req.body?.note !== undefined) s.tirage.note = ligne(req.body.note, 300);
    await enregistrer(annee, s);
    res.json(s);
  }));
}
