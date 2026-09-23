// ===========================================================================
//  Connecteur de prospection EasyBeer
// ===========================================================================
// EasyBeer possède son propre module de prospection : prospects, états de
// contact, actions commerciales, tournées, transformation prospect → client.
// Plutôt que d'entretenir un second CRM local — et donc une double saisie —,
// cette couche lit et écrit dans EasyBeer, qui reste la source de référence.
//
// Capacités vérifiées en lecture sur l'API de production (23/09/2026) :
//   GET  /parametres/utilisateur/liste                       → commerciaux
//   GET  /parametres/client-prospect/liste/{idUtilisateur}   → 125 prospects
//   GET  /referentiel/client/etats-contact                   → 12 états
//   GET  /referentiel/action-client/types                    → 11 types
//   GET  /referentiel/action-client/etats                    → 5 états
//   GET  /commande/derniere-commande/{idClient}              → dernière commande
//
// Capacités implémentées d'après le contrat Swagger mais NON vérifiées en
// écriture (aucune écriture n'a été tentée sur les données réelles) :
//   POST /parametres/client/actions            (liste filtrée des actions)
//   POST /parametres/client/action/enregistrer (créer / modifier une action)
//   POST /parametres/prospect/transformer-en-client
// L'endpoint /api/prospection/diagnostic les exerce à la demande et dit
// lesquelles répondent réellement, sans rien écrire.

const CACHE_MS = 10 * 60 * 1000;   // référentiels : stables, 10 min suffisent
const PROSPECTS_MS = 2 * 60 * 1000;

const cache = new Map();
async function enCache(cle, ttl, produire) {
  const e = cache.get(cle);
  if (e && Date.now() < e.expire) return e.valeur;
  const valeur = await produire();
  cache.set(cle, { valeur, expire: Date.now() + ttl });
  return valeur;
}
const viderCache = prefixe => {
  for (const k of cache.keys()) if (k.startsWith(prefixe)) cache.delete(k);
};

// --- Normalisation ---------------------------------------------------------
// L'API renvoie des objets riches ; on n'expose au navigateur que ce dont
// l'écran a besoin, en forme stable. Une évolution du modèle EasyBeer ne
// casse alors que cette fonction, pas l'interface.

const listeDe = d => Array.isArray(d) ? d : (d?.liste ?? d?.contenu ?? d?.elements ?? []);

function normaliserProspect(p) {
  const a = p.adresse ?? {};
  const contact = (p.contacts ?? [])[0] ?? {};
  return {
    idClient: p.idClient,
    nom: p.nom ?? '',
    numero: p.numero ?? '',
    ville: a.ville ?? '',
    codePostal: a.codePostal ?? '',
    adresse: a.complete ?? '',
    lat: a.latitude ?? null,
    lng: a.longitude ?? null,
    type: p.type?.libelle ?? p.type?.nom ?? '',
    tournee: p.tournee?.libelle ?? p.tournee?.nom ?? '',
    commercial: p.commercial?.denomination ?? p.commercial?.nom ?? '',
    idCommercial: p.commercial?.id ?? p.commercial?.idUtilisateur ?? null,
    etatContact: p.etatContact?.code ?? null,
    etatContactLibelle: p.etatContact?.libelle ?? '',
    etatContactCouleur: p.etatContact?.couleur ?? null,
    nombreActions: p.nombreActions ?? 0,
    note: typeof p.note === 'string' ? p.note : (p.note?.commentaire ?? ''),
    actif: p.actif !== false,
    contact: {
      nom: [contact.prenom, contact.nom].filter(Boolean).join(' '),
      telephone: contact.telephone ?? contact.mobile ?? '',
      email: contact.email ?? '',
    },
  };
}

function normaliserAction(a) {
  return {
    idAction: a.idClientAction ?? null,
    idClient: a.idClient ?? null,
    nomClient: a.nomClient ?? a.raisonSociale ?? '',
    libelle: a.libelle ?? '',
    description: a.description ?? a.commentaire ?? '',
    date: a.date ?? null,
    type: a.type?.code ?? null,
    typeLibelle: a.type?.libelle ?? '',
    etat: a.etat?.code ?? null,
    etatLibelle: a.etat?.libelle ?? '',
    priorite: a.priorite?.code ?? null,
    responsable: a.responsable?.denomination ?? '',
    idResponsable: a.responsable?.id ?? null,
    joursRestants: a.joursRestantAvantAction ?? null,
    dateDerniereCommande: a.dateDerniereCommande ?? null,
  };
}

// --- Montage des routes ----------------------------------------------------

export function monterProspection(app, { easybeerGet, easybeerPost }) {
  // Toute route de prospection remonte une erreur exploitable sans jamais
  // laisser filtrer d'identifiant : une panne EasyBeer doit se voir dans
  // l'interface, pas faire planter la page.
  const repondre = (res, fn) => fn().catch(err => {
    console.error('prospection:', err.message);
    res.status(err.status ?? 502).json({ error: err.message, source: 'easybeer' });
  });

  const commerciaux = () => enCache('utilisateurs', CACHE_MS, async () => {
    const d = await easybeerGet('/parametres/utilisateur/liste');
    return listeDe(d)
      .filter(u => !u.estClient)
      .map(u => ({ id: u.id, nom: u.denomination ?? [u.prenom, u.nom].filter(Boolean).join(' '), actif: !!u.actif }));
  });

  // --- Référentiels : alimentent les filtres et les formulaires ---
  app.get('/api/prospection/referentiels', (req, res) => repondre(res, async () => {
    const [etatsContact, typesAction, etatsAction, utilisateurs] = await Promise.all([
      enCache('etats-contact', CACHE_MS, () => easybeerGet('/referentiel/client/etats-contact').then(listeDe)),
      enCache('types-action', CACHE_MS, () => easybeerGet('/referentiel/action-client/types').then(listeDe)),
      enCache('etats-action', CACHE_MS, () => easybeerGet('/referentiel/action-client/etats').then(listeDe)),
      commerciaux(),
    ]);
    res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    res.json({ etatsContact, typesAction, etatsAction, utilisateurs });
  }));

  // --- Prospects : union des portefeuilles de chaque commercial ---
  // L'API expose la liste par utilisateur ; on agrège pour obtenir le
  // portefeuille complet, en dédoublonnant sur idClient.
  app.get('/api/prospection/prospects', (req, res) => repondre(res, async () => {
    const donnees = await enCache('prospects', PROSPECTS_MS, async () => {
      const users = await commerciaux();
      const parId = new Map();
      const echecs = [];
      for (const u of users.filter(x => x.actif)) {
        try {
          const l = listeDe(await easybeerGet(`/parametres/client-prospect/liste/${u.id}`, 25000));
          for (const p of l) if (p?.idClient && !parId.has(p.idClient)) parId.set(p.idClient, normaliserProspect(p));
        } catch (e) { echecs.push({ commercial: u.nom, raison: e.message }); }
      }
      // Aucun portefeuille lu : c'est une panne, pas un portefeuille vide.
      if (!parId.size && echecs.length) {
        throw Object.assign(new Error('Aucun portefeuille de prospection lisible'), { status: 502 });
      }
      return { prospects: [...parId.values()], echecs, synchroniseLe: Date.now() };
    });
    res.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    res.json(donnees);
  }));

  // --- Actions commerciales (tâches et historique) ---
  // Contrat Swagger : POST avec { filtre, periode } et pagination en query.
  app.get('/api/prospection/actions', (req, res) => repondre(res, async () => {
    const depuis = Number(req.query.depuis) || Date.now() - 90 * 86400000;
    const jusqua = Number(req.query.jusqua) || Date.now() + 90 * 86400000;
    const corps = { filtre: {}, periode: { dateDebut: depuis, dateFin: jusqua } };
    const d = await easybeerPost('/parametres/client/actions?nombreParPage=500&numeroPage=1', corps);
    res.set('Cache-Control', 'no-store');
    res.json({ actions: listeDe(d).map(normaliserAction), synchroniseLe: Date.now() });
  }));

  // --- Enregistrer une action (visite, appel, relance) ---
  // Écriture volontairement minimale : on ne renvoie que ce que l'écran a
  // saisi, jamais un objet reconstitué, pour ne rien écraser par inadvertance.
  app.post('/api/prospection/action', (req, res) => repondre(res, async () => {
    const { idClient, libelle, description, date, type, etat, idResponsable } = req.body ?? {};
    if (!Number.isInteger(idClient)) {
      return res.status(400).json({ error: 'idClient requis' });
    }
    if (!libelle || typeof libelle !== 'string') {
      return res.status(400).json({ error: 'libelle requis' });
    }
    const modele = {
      idClient,
      libelle: libelle.slice(0, 200),
      description: (description ?? '').slice(0, 2000),
      date: Number(date) || Date.now(),
      ...(type ? { type: { code: type } } : {}),
      ...(etat ? { etat: { code: etat } } : {}),
      ...(Number.isInteger(idResponsable) ? { responsable: { id: idResponsable } } : {}),
    };
    const d = await easybeerPost('/parametres/client/action/enregistrer', modele);
    viderCache('prospects');   // nombreActions change
    res.json({ ok: true, resultat: d ?? null });
  }));

  // --- Dernière commande : sert à préparer la relance ---
  app.get('/api/prospection/derniere-commande/:idClient', (req, res) => repondre(res, async () => {
    const id = parseInt(req.params.idClient, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'idClient invalide' });
    try {
      const d = await easybeerGet(`/commande/derniere-commande/${id}`);
      res.set('Cache-Control', 'public, s-maxage=600');
      res.json({
        idCommande: d?.idCommande ?? null,
        numero: d?.numero ?? null,
        date: d?.dateLivraisonPrevue ?? d?.dateCreation ?? null,
        totalHT: d?.totalHT ?? null,
      });
    } catch (e) {
      // Un prospect n'a par définition jamais commandé : ce n'est pas une panne.
      if (e.status === 404) return res.json({ idCommande: null });
      throw e;
    }
  }));

  // --- Diagnostic : dit honnêtement ce qui répond et ce qui ne répond pas ---
  // Aucune écriture n'est tentée ici. Permet de distinguer « implémenté » de
  // « intégration vérifiée » sans avoir à lire le code.
  app.get('/api/prospection/diagnostic', async (req, res) => {
    const essais = [
      ['referentiel.etats-contact', () => easybeerGet('/referentiel/client/etats-contact')],
      ['referentiel.types-action', () => easybeerGet('/referentiel/action-client/types')],
      ['referentiel.etats-action', () => easybeerGet('/referentiel/action-client/etats')],
      ['utilisateurs', () => easybeerGet('/parametres/utilisateur/liste')],
      ['prospects', async () => {
        const u = (await commerciaux()).find(x => x.actif);
        if (!u) throw new Error('aucun commercial actif');
        return easybeerGet(`/parametres/client-prospect/liste/${u.id}`);
      }],
      ['actions.liste', () => easybeerPost('/parametres/client/actions?nombreParPage=1&numeroPage=1',
        { filtre: {}, periode: { dateDebut: Date.now() - 30 * 86400000, dateFin: Date.now() } })],
    ];
    const resultats = {};
    for (const [nom, fn] of essais) {
      try {
        const d = await fn();
        resultats[nom] = { ok: true, elements: listeDe(d).length };
      } catch (e) {
        resultats[nom] = { ok: false, erreur: e.message, status: e.status ?? null };
      }
    }
    resultats['actions.ecriture'] = { ok: null, note: 'non testé : exercer une écriture créerait une action réelle' };
    res.set('Cache-Control', 'no-store');
    res.json({ verifieLe: new Date().toISOString(), resultats });
  });
}
