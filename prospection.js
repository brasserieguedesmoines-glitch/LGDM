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
//   POST /parametres/client/actions (filtre complet, sans période) → 87 actions
//        (vérifié le 24/09/2026 ; voir FILTRE_ACTIONS pour la forme exigée)
//
// Capacités implémentées d'après le contrat Swagger mais NON vérifiées en
// écriture (aucune écriture n'a été tentée sur les données réelles) :
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

// Certains états arrivent sans libellé (A_RECONTACTER, observé en production) :
// on le reconstitue depuis le code plutôt que d'afficher « statut inconnu ».
const libelleDe = e => e?.libelle || String(e?.code ?? '')
  .toLowerCase().replace(/_/g, ' ').replace(/^a /, 'à ').replace(/^./, c => c.toUpperCase());

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
    etatContactLibelle: p.etatContact?.code ? libelleDe(p.etatContact) : '',
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

// EasyBeer stocke les comptes rendus en HTML (« <p>…</p> ») : on n'envoie au
// navigateur que du texte, l'aperçu fourni par l'API ou le HTML dépouillé.
const texteSeul = h => String(h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

function normaliserAction(a) {
  return {
    idAction: a.idClientAction ?? null,
    idClient: a.idClient ?? null,
    nomClient: a.client ?? a.nomClient ?? a.raisonSociale ?? '',
    etatClient: a.etatClient ?? null,          // CLIENT | PROSPECT
    typeClient: a.typeClient ?? '',
    tournee: a.tournee ?? '',
    adresse: a.adresse ?? '',
    telephone: a.telephoneClient ?? a.mobileClient ?? '',
    libelle: a.libelle ?? '',
    description: a.apercu ? texteSeul(a.apercu) : texteSeul(a.description ?? a.commentaire),
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
      enCache('etats-contact', CACHE_MS, () => easybeerGet('/referentiel/client/etats-contact')
        .then(d => listeDe(d).map(e => ({ ...e, libelle: libelleDe(e) })))),
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
  // Forme vérifiée sur l'API de production le 24/09/2026, après des 500
  // systématiques : comme pour la liste des commandes, EasyBeer exige que
  // chaque liste du filtre soit présente (vide) plutôt qu'absente. Toute
  // période — dans le filtre ou sur le paramètre, datée ou nommée — fait en
  // revanche échouer la requête : on lit donc toutes les actions et on trie
  // par date côté serveur. Le volume (une centaine) le permet sans peine.
  const FILTRE_ACTIONS = {
    etats: [], idsClientsDistributeurs: [], idsClientsTournees: [], idsClientsTypes: [],
    priorites: [], types: [], recherche: '',
  };
  const PAR_PAGE_ACTIONS = 200;
  const ACTIONS_MS = 60 * 1000;

  async function lireActions(maxPages = 10) {
    const parId = new Map();
    let total = null;
    for (let page = 1; page <= maxPages; page++) {
      const d = await easybeerPost(
        `/parametres/client/actions?colonneTri=date&nombreParPage=${PAR_PAGE_ACTIONS}&numeroPage=${page}`,
        { filtre: FILTRE_ACTIONS });
      total ??= d?.totalElements ?? null;
      const l = listeDe(d);
      // Dédoublonnage : protège d'un éventuel recouvrement entre pages.
      for (const a of l) if (a?.idClientAction && !parId.has(a.idClientAction)) parId.set(a.idClientAction, a);
      if (l.length < PAR_PAGE_ACTIONS) break;
    }
    return { actions: [...parId.values()].map(normaliserAction), total };
  }

  app.get('/api/prospection/actions', (req, res) => repondre(res, async () => {
    const { actions, total } = await enCache('actions', ACTIONS_MS, lireActions);
    res.set('Cache-Control', 'no-store');
    res.json({
      actions: actions.sort((a, b) => (a.date ?? 0) - (b.date ?? 0)),
      total,
      synchroniseLe: Date.now(),
    });
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
    // Les listes vides reprennent la forme d'une action lue dans EasyBeer :
    // la lecture échoue sans elles, l'écriture a toutes les chances d'en faire autant.
    const modele = {
      idClient,
      idsClients: [], idsClientsActions: [], tags: [], fichiers: [],
      libelle: libelle.slice(0, 200),
      description: (description ?? '').slice(0, 2000),
      date: Number(date) || Date.now(),
      ...(type ? { type: { code: type } } : {}),
      ...(etat ? { etat: { code: etat } } : {}),
      ...(Number.isInteger(idResponsable) ? { responsable: { id: idResponsable } } : {}),
    };
    const d = await easybeerPost('/parametres/client/action/enregistrer', modele);
    viderCache('prospects');   // nombreActions change
    viderCache('actions');
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
      // EasyBeer répond alors 404 ou un corps vide (JSON illisible).
      if (e.status === 404 || e instanceof SyntaxError) return res.json({ idCommande: null });
      throw e;
    }
  }));

  // --- Changer l'état de contact d'un prospect ---
  // Route dédiée d'EasyBeer (GET /parametres/prospect/etat-contact/{id}/{etat}) :
  // elle ne touche qu'à l'état, pas au reste de la fiche. L'état demandé est
  // contrôlé contre le référentiel, et le résultat relu dans la réponse.
  app.post('/api/prospection/etat-contact', (req, res) => repondre(res, async () => {
    const id = Number(req.body?.idClient);
    const etat = String(req.body?.etat ?? '');
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'idClient requis' });
    const etats = await enCache('etats-contact-codes', CACHE_MS, async () =>
      listeDe(await easybeerGet('/referentiel/client/etats-contact')).map(e => e.code));
    if (!etats.includes(etat)) return res.status(400).json({ error: `État inconnu : ${etat}` });

    const d = await easybeerGet(`/parametres/prospect/etat-contact/${id}/${encodeURIComponent(etat)}`);
    const obtenu = d?.etatContact?.code ?? null;
    viderCache('prospects');
    res.json({ ok: true, idClient: id, etat: obtenu ?? etat, confirme: obtenu === etat,
      etatContact: d?.etatContact ? { code: obtenu, libelle: libelleDe(d.etatContact), couleur: d.etatContact.couleur ?? null } : null });
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
      ['actions.liste', () => easybeerPost(
        '/parametres/client/actions?colonneTri=date&nombreParPage=1&numeroPage=1',
        { filtre: FILTRE_ACTIONS })],
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
