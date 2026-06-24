import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const BASE_URL = 'https://api.easybeer.fr';
const AUTH = Buffer.from(
  `${process.env.EASYBEER_API_USER}:${process.env.EASYBEER_API_PASSWORD}`
).toString('base64');

function easybeerHeaders() {
  return {
    'Authorization': `Basic ${AUTH}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function easybeerGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: easybeerHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`EasyBeer ${res.status}`), { status: res.status, detail: text });
  }
  return res.json();
}

async function easybeerPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: easybeerHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`EasyBeer ${res.status}: ${text}`), { status: res.status, detail: text });
  }
  return res.json();
}

// Cache toutes les grilles par idClientType (1h)
const grillesCache = new Map(); // idClientType → { data, expiry }

async function getGrilleByType(idClientType) {
  const cached = grillesCache.get(idClientType);
  if (cached && Date.now() < cached.expiry) return cached.data;
  const data = await easybeerGet(`/parametres/grille-tarifaire/matrice/client?idClientType=${idClientType}`);
  grillesCache.set(idClientType, { data, expiry: Date.now() + 60 * 60 * 1000 });
  return data;
}

// Cache types client (1h)
let typesClientCache = null;
let typesClientExpiry = 0;
async function getTypesClient() {
  if (!typesClientCache || Date.now() > typesClientExpiry) {
    typesClientCache = await easybeerGet('/parametres/client/type');
    typesClientExpiry = Date.now() + 60 * 60 * 1000;
  }
  return typesClientCache;
}

// Map clientId → idClientType (peuplé au chargement des clients)
const clientTypeMap = new Map();

// Charge toutes les grilles et retourne { clients fusionnés, grilles par type }
let allClientsCache = null;
let allClientsCacheExpiry = 0;
async function getAllClients() {
  if (allClientsCache && Date.now() < allClientsCacheExpiry) return allClientsCache;
  const types = await getTypesClient();
  const allClients = new Map(); // idClient → { id, nom }
  clientTypeMap.clear();
  // Chargement séquentiel pour éviter le rate limit EasyBeer (10 req/s)
  for (const t of types) {
    try {
      const data = await getGrilleByType(t.idClientType);
      for (const c of (data.clients ?? [])) {
        const id = c.modeleClient.idClient;
        if (!c.modeleClient.supprime && !allClients.has(id)) {
          allClients.set(id, { id, nom: c.modeleClient.nom });
          clientTypeMap.set(id, t.idClientType);
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  allClientsCache = [...allClients.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  allClientsCacheExpiry = Date.now() + 60 * 60 * 1000;
  return allClientsCache;
}

// Retourne les produits d'un client depuis sa grille tarifaire
async function getProduitsClient(idClient) {
  const idClientType = clientTypeMap.get(idClient);
  if (!idClientType) {
    // clientTypeMap pas encore peuplé, recharge
    await getAllClients();
  }
  const type = clientTypeMap.get(idClient);
  if (!type) throw Object.assign(new Error('Client non trouvé'), { status: 404 });
  const data = await getGrilleByType(type);

  const condMap = {};
  for (const c of data.conditionnements) {
    const key = `${c.produit.idProduit}-${c.contenant.idContenant}-${c.lot.idLot}`;
    condMap[key] = {
      idProduit: c.produit.idProduit,
      libelle: c.produit.nom,
      contenant: c.contenant.libelleAvecContenance ?? c.contenant.nom,
      idContenant: c.contenant.idContenant,
      idLot: c.lot.idLot,
    };
  }

  const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
  if (!clientData) throw Object.assign(new Error('Client non trouvé dans la grille'), { status: 404 });

  const seen = new Set();
  const produits = [];
  for (const t of clientData.tarifs) {
    const key = `${t.modeleProduit.idProduit}-${t.modeleContenant.idContenant}-${t.modeleLot.idLot}`;
    if (!seen.has(key) && condMap[key]) {
      seen.add(key);
      produits.push(condMap[key]);
    }
  }
  return produits;
}

// --- Debug tarifs bruts ---
app.get('/api/debug-tarifs/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const data = await getGrille();
    const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
    if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });
    const tarif0 = clientData.tarifs[0];
    const tarif1 = clientData.tarifs[1];
    // Cherche un conditionnement correspondant
    const cond0 = tarif0 ? data.conditionnements.find(c =>
      c.produit.idProduit === tarif0.modeleProduit.idProduit &&
      c.contenant.idContenant === tarif0.modeleContenant.idContenant &&
      c.lot.idLot === tarif0.modeleLot.idLot
    ) : null;
    // Clés des conditionnements disponibles (5 premiers)
    const condKeys = data.conditionnements.slice(0, 5).map(c =>
      `${c.produit.idProduit}-${c.contenant.idContenant}-${c.lot.idLot}`
    );
    res.json({
      nbTarifs: clientData.tarifs.length,
      nbConditionnements: data.conditionnements.length,
      tarif0,
      tarif1,
      cond0,
      condKeys,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug prix ---
app.get('/api/debug-prix/:idContenant/:idProduit/:idLot', async (req, res) => {
  try {
    const { idContenant, idProduit, idLot } = req.params;
    // Essaie plusieurs variantes d'endpoint
    const candidates = [
      `/parametres/grille-tarifaire/${idContenant}/${idProduit}/${idLot}`,
      `/parametres/grille-tarifaire/${idProduit}/${idContenant}/${idLot}`,
      `/parametres/grille-tarifaire/prix/${idContenant}/${idProduit}/${idLot}`,
      `/parametres/grille-tarifaire/prix/${idProduit}/${idContenant}/${idLot}`,
    ];
    const results = {};
    for (const path of candidates) {
      try {
        results[path] = await easybeerGet(path);
      } catch (e) {
        results[path] = { error: e.message };
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug dernière commande complète ---
app.get('/api/debug-derniere-commande/:idClient', async (req, res) => {
  try {
    const cmd = await easybeerGet(`/commande/derniere-commande/${req.params.idClient}`);
    res.json({
      grilleTarifaire: cmd.grilleTarifaire,
      elementsBouteilles: (cmd.elementsBouteilles ?? []).slice(0, 2),
      elementsContenants: (cmd.elementsContenants ?? []).slice(0, 2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : liste les endpoints Swagger contenant un mot-clé ---
app.get('/api/debug-swagger-search/:keyword', async (req, res) => {
  try {
    const swagger = await easybeerGet('/v2/api-docs');
    const kw = req.params.keyword.toLowerCase();
    const paths = Object.keys(swagger.paths).filter(p => p.toLowerCase().includes(kw));
    res.json(paths);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : teste un endpoint GET ---
app.get('/api/debug-get', async (req, res) => {
  try {
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path requis' });
    const data = await easybeerGet(path);
    const preview = Array.isArray(data) ? { count: data.length, sample: data.slice(0, 3) } : data;
    res.json(preview);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// --- Debug Swagger definitions ---
app.get('/api/debug-swagger-def/:name', async (req, res) => {
  try {
    const swagger = await easybeerGet('/v2/api-docs');
    const def = swagger.definitions[req.params.name];
    res.json(def ?? { error: 'définition non trouvée', available: Object.keys(swagger.definitions).filter(k => k.toLowerCase().includes('commande')) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug commande : teste la structure correcte ---
app.get('/api/debug-commande/:idClient', async (req, res) => {
  const idClient = parseInt(req.params.idClient);
  const data = await getGrille();
  const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });
  const t = clientData.tarifs[0];

  // Récupère typeClient depuis l'endpoint de prix
  let typeClient = null;
  let idClientType = null;
  try {
    const tarifs = await easybeerGet(`/parametres/grille-tarifaire/${t.modeleContenant.idContenant}/${t.modeleProduit.idProduit}/${t.modeleLot.idLot}`);
    const ligneP = Array.isArray(tarifs) ? (tarifs.find(x => x.idClient === idClient) ?? tarifs[0]) : null;
    typeClient = ligneP?.typeClient ?? null;
    // Cherche idClientType dans typesClient de la grille
    const typesClient = data.typesClient ?? [];
    const tc = typesClient.find(x => x.libelle === typeClient || x.typeClient === typeClient);
    idClientType = tc?.idClientType ?? tc?.id ?? null;
  } catch {}

  const ligne = { produit: { idProduit: t.modeleProduit.idProduit }, contenant: { idContenant: t.modeleContenant.idContenant }, lot: { idLot: t.modeleLot.idLot }, quantite: 1 };
  const payloads = [
    {
      label: 'grilleTarifaire:{idClientType}',
      body: { client: { idClient }, grilleTarifaire: { idClientType }, commentaire: 'TEST', elementsBouteilles: [ligne] },
    },
    {
      label: 'grilleTarifaire:{libelle}',
      body: { client: { idClient }, grilleTarifaire: { libelle: typeClient }, commentaire: 'TEST', elementsBouteilles: [ligne] },
    },
  ];

  const results = [];
  for (const p of payloads) {
    try {
      const r = await easybeerPost('/commande/enregistrer', p.body);
      results.push({ label: p.label, ok: true, result: r });
      break;
    } catch (e) {
      results.push({ label: p.label, ok: false, error: e.message, detail: e.detail });
    }
  }
  // Cherche idClientType dans la dernière commande du client
  let derniereCommande = null;
  let grilleTarifaireExistante = null;
  try {
    derniereCommande = await easybeerGet(`/commande/derniere-commande/${idClient}`);
    grilleTarifaireExistante = derniereCommande?.grilleTarifaire ?? null;
    if (grilleTarifaireExistante?.idClientType) idClientType = grilleTarifaireExistante.idClientType;
  } catch {}

  // Utilise la grilleTarifaire complète de la dernière commande
  const grilleTarifaire = grilleTarifaireExistante ?? { idClientType };

  // Teste différentes structures d'éléments
  const elemTest = [
    { label: 'produit+contenant+lot objets', elem: { produit: { idProduit: t.modeleProduit.idProduit }, contenant: { idContenant: t.modeleContenant.idContenant }, lot: { idLot: t.modeleLot.idLot }, quantite: 1 } },
    { label: 'idProduit+idContenant+idLot plats', elem: { idProduit: t.modeleProduit.idProduit, idContenant: t.modeleContenant.idContenant, idLot: t.modeleLot.idLot, quantite: 1 } },
    { label: 'produit+contenant+lot+quantiteCarton', elem: { produit: { idProduit: t.modeleProduit.idProduit }, contenant: { idContenant: t.modeleContenant.idContenant }, lot: { idLot: t.modeleLot.idLot }, quantite: 1, quantiteCarton: 0 } },
  ];

  for (const e of elemTest) {
    try {
      const r = await easybeerPost('/commande/enregistrer', {
        client: { idClient }, grilleTarifaire, commentaire: 'TEST', elementsBouteilles: [e.elem],
      });
      results.push({ label: e.label, ok: true, result: r });
      break;
    } catch (ex) {
      results.push({ label: e.label, ok: false, error: ex.message, detail: ex.detail });
    }
  }

  res.json({ typeClient, idClientType, results });
});

// --- Clients ---
app.get('/api/clients', async (req, res) => {
  try {
    // Inclut idClientType pour que le frontend puisse l'envoyer avec la commande
    const clients = await getAllClients();
    res.json(clients.map(c => ({ ...c, idClientType: clientTypeMap.get(c.id) })));
  } catch (err) {
    console.error('GET /api/clients', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

app.get('/api/tarifs/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    res.json(await getProduitsClient(idClient));
  } catch (err) {
    console.error('GET /api/tarifs', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// --- Dernière commande client ---
app.get('/api/derniere-commande/:idClient', async (req, res) => {
  try {
    const data = await easybeerGet(`/commande/derniere-commande/${req.params.idClient}`);
    res.json(data);
  } catch (err) {
    console.error('GET /api/derniere-commande', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// --- Debug commande : teste différentes structures (GET, ouvrir dans le navigateur) ---
app.get('/api/debug-commande/:idClient', async (req, res) => {
  const idClient = parseInt(req.params.idClient);
  // Récupère le premier produit du client
  const data = await getGrille();
  const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });
  const t = clientData.tarifs[0];
  const ligne = { idProduit: t.modeleProduit.idProduit, idContenant: t.modeleContenant.idContenant, idLot: t.modeleLot.idLot ?? 1, quantite: 1 };

  const payloads = [
    { label: 'idClient + lignesCommande', body: { idClient, commentaire: 'TEST', lignesCommande: [ligne] } },
    { label: 'idClient + lignes',         body: { idClient, commentaire: 'TEST', lignes: [ligne] } },
    { label: 'idClientLivraison',         body: { idClientLivraison: idClient, commentaire: 'TEST', lignesCommande: [ligne] } },
  ];

  const results = [];
  for (const p of payloads) {
    try {
      const r = await easybeerPost('/commande/enregistrer', p.body);
      results.push({ label: p.label, ok: true, result: r });
      break; // arrête au premier succès
    } catch (e) {
      results.push({ label: p.label, ok: false, error: e.message, detail: e.detail });
    }
  }
  res.json({ ligne, results });
});

// --- Debug Swagger path complet ---
app.get('/api/debug-swagger-path', async (req, res) => {
  try {
    const swagger = await easybeerGet('/v2/api-docs');
    const path = req.query.path;
    res.json(swagger.paths[path] ?? { error: 'path non trouvé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : liste clients paginée ---
app.get('/api/debug-post-clients', async (req, res) => {
  const candidates = [
    { method: 'GET', path: '/parametres/client/tournee' },
    { method: 'GET', path: '/indicateur/classement-clients?dateDebut=2020-01-01&dateFin=2030-01-01' },
    { method: 'GET', path: '/parametres/grille-tarifaire/autre/matrice/client' },
    { method: 'GET', path: '/parametres/brasserie-cliente/liste' },
  ];
  const results = [];
  for (const c of candidates) {
    try {
      const r = await fetch(`${BASE_URL}${c.path}`, { method: c.method, headers: easybeerHeaders() });
      const d = await r.json();
      const arr = Array.isArray(d) ? d : (d?.liste ?? d?.clients ?? d?.contenu ?? null);
      results.push({ path: c.path, status: r.status, count: arr ? arr.length : '?', sample: arr ? arr[0] : d });
    } catch (e) {
      results.push({ path: c.path, error: e.message });
    }
  }
  res.json(results);
});

// --- Debug : teste toutes les grilles tarifaires pour récupérer + de clients ---
app.get('/api/debug-toutes-grilles', async (req, res) => {
  try {
    // 1. Récupère les types de client (= les grilles disponibles)
    const types = await getTypesClient();
    const results = [];

    // 2. Pour chaque type, essaie /parametres/grille-tarifaire/matrice/client avec ce type
    for (const t of types.slice(0, 10)) {
      const candidates = [
        `/parametres/grille-tarifaire/matrice/client?idClientType=${t.idClientType}`,
        `/parametres/grille-tarifaire/${t.idClientType}/matrice/client`,
      ];
      for (const path of candidates) {
        try {
          const r = await fetch(`${BASE_URL}${path}`, { headers: easybeerHeaders() });
          const d = await r.json();
          const clients = d?.clients ?? d;
          const count = Array.isArray(clients) ? clients.length : (clients?.length ?? '?');
          results.push({ idClientType: t.idClientType, libelle: t.libelle, path, status: r.status, nbClients: count });
          break;
        } catch (e) {
          results.push({ idClientType: t.idClientType, path, error: e.message });
        }
      }
    }
    // 3. Essaie aussi les endpoints client directs
    const directCandidates = [
      '/parametres/client/actif',
      '/parametres/client/liste?page=0&taille=200',
      '/parametres/client/recherche?nom=',
      '/commande/client/liste',
    ];
    for (const path of directCandidates) {
      try {
        const r = await fetch(`${BASE_URL}${path}`, { headers: easybeerHeaders() });
        const d = await r.json();
        const arr = Array.isArray(d) ? d : (d?.liste ?? d?.clients ?? d?.contenu ?? d?.content ?? null);
        results.push({ path, status: r.status, count: arr ? arr.length : '?', sample: arr ? arr[0] : d });
      } catch (e) {
        results.push({ path, error: e.message });
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Rejoue la dernière commande d'un client et teste plusieurs variantes
app.get('/api/debug-rejouer/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const idClientType = parseInt(req.query.ict ?? '10320');

    // 1. Récupère la dernière commande pour voir la structure réelle
    let derniereCmd = null;
    let elemSample = null;
    try {
      derniereCmd = await easybeerGet(`/commande/derniere-commande/${idClient}`);
      elemSample = (derniereCmd.elementsBouteilles ?? [])[0] ?? null;
    } catch (e) {
      derniereCmd = { error: e.message };
    }

    if (!elemSample) {
      return res.json({ info: 'Pas de dernière commande', derniereCmd });
    }

    // 2. Teste différentes structures avec le premier élément de la vraie dernière commande
    const base = {
      client: { idClient },
      grilleTarifaire: { idClientType },
      commentaire: 'TEST DEBUG',
    };
    const elem = elemSample;
    const variants = [
      { label: 'structure objets', elementsBouteilles: [{ produit: { idProduit: elem.produit?.idProduit }, contenant: { idContenant: elem.contenant?.idContenant }, lot: { idLot: elem.lot?.idLot }, quantite: 1 }] },
      { label: 'sans lot',         elementsBouteilles: [{ produit: { idProduit: elem.produit?.idProduit }, contenant: { idContenant: elem.contenant?.idContenant }, quantite: 1 }] },
      { label: 'copie exacte',     elementsBouteilles: [{ ...elem, quantite: 1 }] },
    ];

    const results = [];
    for (const v of variants) {
      await new Promise(r => setTimeout(r, 150));
      try {
        const r = await easybeerPost('/commande/enregistrer', { ...base, ...v });
        results.push({ label: v.label, ok: true, result: r });
        break;
      } catch (e) {
        results.push({ label: v.label, ok: false, error: e.message });
      }
    }

    res.json({ idClientType, elemSample, grilleTarifaireCmd: derniereCmd.grilleTarifaire, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-payload/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    await getAllClients(); // assure le peuplement de clientTypeMap
    const idClientType = clientTypeMap.get(idClient);
    const produits = idClientType ? await getProduitsClient(idClient) : [];
    const p = produits[0];
    const lignes = p ? [{ idProduit: p.idProduit, idContenant: p.idContenant, idLot: p.idLot, quantite: 1 }] : [];
    const payload = {
      client: { idClient },
      grilleTarifaire: idClientType ? { idClientType } : undefined,
      commentaire: 'TEST',
      elementsBouteilles: lignes.map(l => ({
        produit: { idProduit: l.idProduit },
        contenant: { idContenant: l.idContenant },
        lot: { idLot: l.idLot },
        quantite: l.quantite,
      })),
    };
    let result = null, error = null;
    try { result = await easybeerPost('/commande/enregistrer', payload); } catch (e) { error = { message: e.message, detail: e.detail }; }
    res.json({ idClientType, payload, result, error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Création de commande ---
app.post('/api/commande', async (req, res) => {
  const payload = {};
  try {
    const { idClient, idClientType, lignes, commentaire } = req.body;
    if (!idClient || !Array.isArray(lignes) || lignes.length === 0) {
      return res.status(400).json({ error: 'idClient et lignes sont requis' });
    }
    Object.assign(payload, {
      client: { idClient },
      grilleTarifaire: idClientType ? { idClientType } : undefined,
      commentaire: commentaire ?? '',
      elementsBouteilles: lignes.map(l => ({
        produit: { idProduit: l.idProduit },
        contenant: { idContenant: l.idContenant },
        lot: { idLot: l.idLot ?? 1 },
        quantite: l.quantite,
      })),
    });
    const result = await easybeerPost('/commande/enregistrer', payload);
    res.json(result);
  } catch (err) {
    console.error('POST /api/commande', err.message, err.detail);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail, payloadEnvoye: payload });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
}

export default app;
