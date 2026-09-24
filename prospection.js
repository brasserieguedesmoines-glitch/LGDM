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
  // Le contrat Swagger décrit « periode » à la fois sur le paramètre et dans le
  // filtre, avec des dates typées « string » sans format précisé. Plutôt que de
  // deviner, on essaie les formes plausibles dans l'ordre et on retient celle
  // qui répond — la forme retenue est ensuite réutilisée sans nouvel essai.
  const jour = t => new Date(t).toISOString().slice(0, 10);
  let formeActions = null;

  function formesActions(depuis, jusqua) {
    return [
      ['filtre.periode.iso', { filtre: { periode: { dateDebut: jour(depuis), dateFin: jour(jusqua) } } }],
      ['filtre.periode.type', { filtre: { periode: { type: 'PERIODE_COURANTE' } } }],
      ['filtre.vide', { filtre: {} }],
      ['parametre.periode.iso', { filtre: {}, periode: { dateDebut: jour(depuis), dateFin: jour(jusqua) } }],
    ];
  }

  app.get('/api/prospection/actions', (req, res) => repondre(res, async () => {
    const depuis = Number(req.query.depuis) || Date.now() - 90 * 86400000;
    const jusqua = Number(req.query.jusqua) || Date.now() + 90 * 86400000;
    const chemin = '/parametres/client/actions?nombreParPage=500&numeroPage=1';
    const candidates = formesActions(depuis, jusqua);
    const ordonnees = formeActions
      ? [candidates.find(([n]) => n === formeActions), ...candidates.filter(([n]) => n !== formeActions)]
      : candidates;

    let derniere = null;
    for (const [nom, corps] of ordonnees.filter(Boolean)) {
      try {
        const d = await easybeerPost(chemin, corps);
        formeActions = nom;
        res.set('Cache-Control', 'no-store');
        return res.json({
          actions: listeDe(d).map(normaliserAction),
          forme: nom,
          synchroniseLe: Date.now(),
        });
      } catch (e) { derniere = e; }
    }
    throw derniere ?? new Error('Aucune forme de requête acceptée pour la liste des actions');
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

  // --- Transformation prospect → client -----------------------------------
  // Règles, volontairement strictes parce que c'est la seule écriture qui
  // change la nature d'une fiche :
  //   1. On ne transforme que par identifiant EasyBeer : jamais sur la
  //      ressemblance d'un nom d'établissement.
  //   2. Un prospect se reconnaît à son numéro préfixé « PR » ; un client
  //      porte « CL ». Une fiche déjà cliente est renvoyée telle quelle sans
  //      rien écrire — réessayer est donc sans danger.
  //   3. On relit la fiche complète et on la renvoie intégralement plutôt que
  //      de fabriquer un objet partiel, qui écraserait les champs absents.
  //   4. Rien n'est supprimé ni propagé : l'historique d'actions reste attaché
  //      au même idClient.
  const estProspect = numero => /^PR/i.test(String(numero ?? ''));

  app.post('/api/prospection/transformer-en-client', (req, res) => repondre(res, async () => {
    const id = Number(req.body?.idClient);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'idClient requis' });

    const fiche = await easybeerGet(`/parametres/client/detail/${id}`);
    if (!fiche?.idClient) {
      return res.status(404).json({ error: 'Fiche introuvable dans EasyBeer' });
    }
    if (!estProspect(fiche.numero)) {
      // Idempotence : déjà client, on ne réécrit rien.
      return res.json({ dejaClient: true, numero: fiche.numero, nom: fiche.nom });
    }

    await easybeerPost('/parametres/prospect/transformer-en-client', fiche);
    viderCache('prospects');

    // On relit pour renvoyer le numéro client réellement attribué, plutôt que
    // d'affirmer un résultat que l'on n'a pas vérifié.
    const apres = await easybeerGet(`/parametres/client/detail/${id}`).catch(() => null);
    res.json({
      ok: true,
      idClient: id,
      nom: fiche.nom,
      numeroAvant: fiche.numero,
      numeroApres: apres?.numero ?? null,
      confirme: apres ? !estProspect(apres.numero) : null,
    });
  }));

  // --- Sonde temporaire (lecture seule) : formes de requête du planning ---
  app.get('/api/prospection/sonde-actions', async (req, res) => {
    const now = Date.now();
    const periodeLibre = { type: 'PERIODE_LIBRE', dateDebut: new Date(now - 90 * 86400000).toISOString(), dateFin: new Date(now + 90 * 86400000).toISOString() };
    const filtreComplet = {
      etats: [], idsClientsDistributeurs: [], idsClientsTournees: [], idsClientsTypes: [],
      priorites: [], types: [], recherche: '',
    };
    const indicateur = {
      periode: { type: 'MOIS_COURANT' }, inclureActionsEnRetard: true,
      idsClients: [], idsClientsTournees: [], idsClientsTypes: [], idsCommerciaux: [],
      idsContenants: [], idsContenantsFuts: [], idsEntrepots: [], idsEtapeBrassage: [],
      idsPackagings: [], idsProduits: [], idsProduitsCategories: [],
    };
    const variantes = [
      ['A liste tri=date p1', '/parametres/client/actions?colonneTri=date&nombreParPage=3&numeroPage=1', { filtre: { ...filtreComplet, periode: periodeLibre }, periode: periodeLibre }],
      ['B liste tri=date p0', '/parametres/client/actions?colonneTri=date&nombreParPage=3&numeroPage=0', { filtre: { ...filtreComplet, periode: periodeLibre }, periode: periodeLibre }],
      ['C liste sans query', '/parametres/client/actions', { filtre: { ...filtreComplet, periode: periodeLibre }, periode: periodeLibre }],
      ['D liste filtre complet sans periode', '/parametres/client/actions?colonneTri=date&nombreParPage=3&numeroPage=1', { filtre: filtreComplet }],
      ['E liste MOIS_COURANT', '/parametres/client/actions?colonneTri=date&nombreParPage=3&numeroPage=1', { filtre: { ...filtreComplet, periode: { type: 'MOIS_COURANT' } }, periode: { type: 'MOIS_COURANT' } }],
      ['F planning', '/parametres/client/actions/planning', { filtre: { ...filtreComplet, periode: periodeLibre }, periode: periodeLibre }],
      ['G indicateur actions-clients', '/indicateur/actions-clients?forceRefresh=false', indicateur],
    ];
    const resultats = [];
    for (const [nom, chemin, corps] of variantes) {
      try {
        const d = await easybeerPost(chemin, corps);
        const l = listeDe(d);
        resultats.push({ nom, ok: true, cles: Object.keys(d ?? {}).slice(0, 15), elements: l.length, total: d?.totalElements ?? null, exemple: JSON.stringify(l[0] ?? d).slice(0, 900) });
      } catch (e) {
        resultats.push({ nom, ok: false, status: e.status ?? null, erreur: String(e.message).slice(0, 200) });
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json(resultats);
  });

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
      ['actions.liste', async () => {
        const chemin = '/parametres/client/actions?nombreParPage=1&numeroPage=1';
        let derniere = null;
        for (const [nom, corps] of formesActions(Date.now() - 30 * 86400000, Date.now())) {
          try { const d = await easybeerPost(chemin, corps); formeActions = nom; return d; }
          catch (e) { derniere = e; }
        }
        throw derniere;
      }],
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
