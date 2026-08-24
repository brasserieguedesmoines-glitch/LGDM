import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import PDFDocument from 'pdfkit';
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

// Disjoncteur : après un ban EasyBeer (5 min), on cesse tout appel pendant 6 min.
// Sans lui, chaque nouvelle tentative pendant le ban le prolongeait indéfiniment.
let banniJusqua = 0;
function erreurBan() {
  return Object.assign(
    new Error('API EasyBeer temporairement saturée. Réessayez dans 5 minutes.'),
    { status: 503 }
  );
}
function erreurEasyBeer(status, text) {
  if (status === 429 || String(text).includes('banned') || String(text).includes('requests per second')) {
    banniJusqua = Date.now() + 6 * 60 * 1000;
    return Object.assign(erreurBan(), { detail: text });
  }
  return Object.assign(new Error(`EasyBeer ${status}`), { status, detail: text });
}

// File d'attente globale : espace les requêtes EasyBeer de 1,2 s. Testé en réel :
// EasyBeer banni même à ~2,5 req/s soutenus — sa limite effective est ~50 appels/min.
// Ne pas descendre sous 1,2 s ; la vitesse perçue vient du cache CDN, pas d'ici.
let dernierAppel = Promise.resolve();
function throttle() {
  const attente = dernierAppel.then(() => new Promise(r => setTimeout(r, 1200)));
  dernierAppel = attente;
  return attente;
}

async function easybeerGet(path) {
  if (Date.now() < banniJusqua) throw erreurBan();
  await throttle();
  const res = await fetch(`${BASE_URL}${path}`, { headers: easybeerHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw erreurEasyBeer(res.status, text);
  }
  return res.json();
}

async function easybeerPost(path, body) {
  if (Date.now() < banniJusqua) throw erreurBan();
  await throttle();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: easybeerHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = erreurEasyBeer(res.status, text);
    if (err.status !== 503) err.message = `EasyBeer ${res.status}: ${text}`;
    throw err;
  }
  return res.json();
}

// Cache idStockBouteille : idProduit-idContenant → idStockBouteille (1h)
let stockBouteilleIndex = null;
let stockBouteilleIndexExpiry = 0;

async function getStockBouteilleIndex() {
  if (stockBouteilleIndex && Date.now() < stockBouteilleIndexExpiry) return stockBouteilleIndex;
  const data = await easybeerGet('/stock/produits/autocomplete?query=a');
  const arr = Array.isArray(data) ? data : (data?.liste ?? data?.contenu ?? []);
  const index = new Map();
  for (const s of arr) {
    if (s.idStockBouteille && s.idProduit && s.idContenant) {
      const key = `${s.idProduit}-${s.idContenant}-${s.idLot ?? 1}`;
      // Garde la première occurrence (entrepôt principal) et l'objet stock complet
      if (!index.has(key)) index.set(key, s);
    }
  }
  stockBouteilleIndex = index;
  stockBouteilleIndexExpiry = Date.now() + 60 * 60 * 1000;
  return index;
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

// Canal de vente déduit du type EasyBeer, puis du nom du client en secours.
// Partagé par la prise de commande (filtrage de gamme) et le pilotage (statistiques).
function canalParLibelleEtNom(libelleType, nom) {
  const lib = (libelleType ?? '').toLowerCase();
  if (lib.includes('chr')) return 'CHR';
  if (lib === 'gd' || lib.includes('enseigne') || lib.includes('grande')) return 'GMS';
  if (lib.includes('distributeur') || lib.includes('ex works')) return 'Distributeurs';
  if (lib.includes('asso')) return 'Associations';
  const n = (nom ?? '').toLowerCase();
  if (/leclerc|intermarch|carrefour|super\s*u|auchan|casino|biocoop|utile|spar|monoprix/.test(n)) return 'GMS';
  if (/burger|restau|\bbar\b|h[ôo]tel|brasserie|pizz|caf[ée]|bistro|\bpub\b|camping|guinguette|food/.test(n)) return 'CHR';
  if (/asso|comit[ée]|\bce\b|festival|club/.test(n)) return 'Associations';
  if (/cave|caviste|[ée]picerie|vins/.test(n)) return 'Cavistes';
  if (lib) return 'Autres pros';
  return 'Non catégorisé';
}

// Gamme d'un produit : la Bruguiéroise est la gamme destinée à la GMS,
// tout le reste constitue la gamme classique (CHR, cavistes, distributeurs…).
function gammeProduit(libelle) {
  return /brugui[éeè]roise/i.test(libelle ?? '') ? 'gms' : 'classique';
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
  }
  allClientsCache = [...allClients.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  allClientsCacheExpiry = Date.now() + 60 * 60 * 1000;
  return allClientsCache;
}

// Retourne les produits d'un client depuis sa grille tarifaire
async function getProduitsClient(idClient) {
  let type = clientTypeMap.get(idClient);
  if (!type) {
    // Fallback léger : 1 appel API au lieu de 10 (getAllClients)
    try {
      const detail = await easybeerGet(`/parametres/client/detail/${idClient}`);
      type = detail?.type?.idClientType;
      if (type) clientTypeMap.set(idClient, type);
    } catch {}
  }
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
      idStockBouteille: c.stockBouteille?.idStockBouteille ?? c.idStockBouteille ?? null, // enrichi après
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
      produits.push({ ...condMap[key], gamme: gammeProduit(condMap[key].libelle) });
    }
  }

  // Enrichit chaque produit avec idStockBouteille depuis l'index autocomplete
  try {
    const index = await getStockBouteilleIndex();
    for (const p of produits) {
      const stock = index.get(`${p.idProduit}-${p.idContenant}-${p.idLot ?? 1}`);
      if (p.idStockBouteille == null) {
        p.idStockBouteille = stock?.idStockBouteille ?? null;
      }
      p.gtin = stock?.gtin ?? null;
    }
  } catch {}

  return produits;
}

// --- Debug conditionnement brut (pour trouver idStockBouteille) ---
app.get('/api/debug-cond-raw/:idClientType', async (req, res) => {
  try {
    const data = await getGrilleByType(parseInt(req.params.idClientType));
    const sample = data.conditionnements?.slice(0, 2) ?? [];
    res.json({ nbConditionnements: data.conditionnements?.length, sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : raw /stock/bouteilles/{idProduit} ---
app.get('/api/debug-stock-raw/:idProduit', async (req, res) => {
  try {
    const data = await easybeerGet(`/stock/bouteilles/${req.params.idProduit}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// --- Debug : structure brute d'un tarif client (pour trouver le champ prix) ---
app.get('/api/debug-tarif-sample/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const type = clientTypeMap.get(idClient) ?? (await easybeerGet(`/parametres/client/detail/${idClient}`))?.type?.idClientType;
    const data = await getGrilleByType(type);
    const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
    const typesClient = await getTypesClient();
    const typeObj = typesClient.find(t => t.idClientType === type);
    res.json({ typeObj, tarifs: clientData?.tarifs?.slice(0, 2) ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// --- Debug : envoie une commande test avec payload complet façon app EasyBeer ---
app.get('/api/debug-send-full/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const idClientType = parseInt(req.query.ict ?? '10319');
    const prixLotHT = parseFloat(req.query.prix ?? '1.5');
    const index = await getStockBouteilleIndex();
    const stock = index.get('22337-12-1');
    const typesClient = await getTypesClient();
    const typeObj = typesClient.find(t => t.idClientType === idClientType) ?? { idClientType };

    const tauxTVA = stock?.tauxTVA;
    const taux = (tauxTVA?.taux ?? 20) / 100;
    const totalHT = prixLotHT;
    const tva = Math.round(totalHT * taux * 100) / 100;

    const payload = {
      client: { type: {}, idClient },
      grilleTarifaire: typeObj,
      commentaire: 'TEST DEBUG FULL',
      adresseLivraison: {},
      droitSuspendu: false,
      echangeHorsUE: false,
      deductionsAvoirs: [],
      listeTropPercus: [],
      elementsContenants: [],
      elementsFuts: [],
      elementsLocations: [],
      elementsAutres: [],
      elementsMatieresPremieres: [],
      elementsSaisieLibre: [],
      elementsBouteilles: [{
        tauxTVA,
        stockProduit: stock,
        stockBouteille: { idStockBouteille: stock?.idStockBouteille },
        valeurRemise: 0,
        participation: 0,
        participationUnitaire: 0,
        prixLotHT,
        prixTotalHT: totalHT,
        quantite: 1,
      }],
      fraisLivraisonHT: 0,
      tauxTVAFraisLivraison: tauxTVA,
      remiseTotale: 0,
      participationTotale: 0,
      totalConsigne: 0,
      poids: 0,
      totalHT,
      tva,
      total: Math.round((totalHT + tva) * 100) / 100,
      tags: [],
    };
    let result = null, error = null;
    try { result = await easybeerPost('/commande/enregistrer', payload); }
    catch (e) { error = { message: e.message, detail: e.detail }; }
    res.json({ result, error, payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : trouve idStockBouteille via différentes approches ---
app.get('/api/debug-find-stock/:idClient', async (req, res) => {
  const idClient = parseInt(req.params.idClient);
  const results = {};
  const candidates = [
    '/stock/bouteilles',
    '/stock/produits',
    '/stock/produits/catalogue',
    '/stock/produits/autocomplete?query=blonde',
    `/stock/produit/correspondant/22337`,
    `/stock/bouteilles/contenants-disponibles`,
    `/commande/commande-en-cours/${idClient}`,
  ];
  for (const path of candidates) {
    try {
      const d = await easybeerGet(path);
      const arr = Array.isArray(d) ? d : (d?.liste ?? d?.content ?? d?.contenu ?? null);
      results[path] = arr ? { count: arr.length, sample: arr[0] } : d;
    } catch (e) {
      results[path] = { error: e.message };
    }
  }
  res.json(results);
});

// --- Debug : cherche idStockBouteille via différents endpoints ---
app.get('/api/debug-stock-bouteille/:idProduit/:idContenant', async (req, res) => {
  const { idProduit, idContenant } = req.params;
  const candidates = [
    `/parametres/stock-bouteille/liste`,
    `/parametres/stock-bouteille?idProduit=${idProduit}&idContenant=${idContenant}`,
    `/parametres/stock-bouteille/par-produit/${idProduit}`,
    `/parametres/stock-bouteille/${idProduit}/${idContenant}`,
    `/stock/bouteille/liste`,
  ];
  const results = {};
  for (const path of candidates) {
    try {
      const d = await easybeerGet(path);
      const arr = Array.isArray(d) ? d : (d?.liste ?? d?.content ?? d?.contenu ?? null);
      results[path] = arr ? { count: arr.length, sample: arr[0] } : d;
    } catch (e) {
      results[path] = { error: e.message };
    }
  }
  res.json(results);
});

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
    // Inclut idClientType pour que le frontend puisse l'envoyer avec la commande,
    // et le canal (CHR / GMS / …) qui détermine la gamme proposée à la saisie
    const clients = await getAllClients();
    const types = await getTypesClient().catch(() => []);
    const libelleType = new Map(types.map(t => [t.idClientType, t.libelle]));
    // Cache CDN Vercel : évite de refaire ~10 appels EasyBeer à chaque visite
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.json(clients.map(c => {
      const idClientType = clientTypeMap.get(c.id);
      return { ...c, idClientType, canal: canalParLibelleEtNom(libelleType.get(idClientType), c.nom) };
    }));
  } catch (err) {
    console.error('GET /api/clients', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

app.get('/api/tarifs/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const produits = await getProduitsClient(idClient);
    res.set('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.json(produits);
  } catch (err) {
    console.error('GET /api/tarifs', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// --- Adresses de livraison d'un client ---
app.get('/api/adresses/:idClient', async (req, res) => {
  try {
    const detail = await easybeerGet(`/parametres/client/detail/${req.params.idClient}`);
    res.set('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.json({
      principale: detail?.adresse?.complete ?? '',
      livraison: (detail?.listeAdresseLivraison ?? []).map(a => ({
        id: a.id,
        complete: a.complete,
        ligne1: a.ligne1, ligne2: a.ligne2, ligne3: a.ligne3, ligne4: a.ligne4,
      })),
    });
  } catch (err) {
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

// --- Debug : cherche le champ natureOperation dans le Swagger ---
app.get('/api/debug-nature', async (req, res) => {
  try {
    const swagger = await easybeerGet('/v2/api-docs');
    const def = swagger.definitions?.ModeleCommande ?? swagger.definitions?.Commande ?? {};
    const enregistrer = swagger.paths?.['/commande/enregistrer'];
    // Cherche tous les champs contenant "nature" dans toutes les définitions
    const natureFields = {};
    for (const [name, def2] of Object.entries(swagger.definitions ?? {})) {
      const props = def2.properties ?? {};
      for (const [k, v] of Object.entries(props)) {
        if (k.toLowerCase().includes('nature') || (v.description ?? '').toLowerCase().includes('nature')) {
          natureFields[`${name}.${k}`] = v;
        }
      }
    }
    res.json({ ModeleCommande: def, enregistrer, natureFields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Debug : teste plusieurs variantes de payload pour /commande/enregistrer ---
app.get('/api/debug-variants/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const detail = await easybeerGet(`/parametres/client/detail/${idClient}`);
    const idClientType = detail?.type?.idClientType;
    if (!idClientType) return res.json({ error: 'Pas de type client', detail });

    const produits = await getProduitsClient(idClient);
    const p = produits[0];
    if (!p) return res.json({ error: 'Aucun produit', idClientType });

    const grille = { idClientType };
    const e1 = { produit: { idProduit: p.idProduit }, contenant: { idContenant: p.idContenant }, lot: { idLot: p.idLot }, quantite: 1 };
    const e2 = { produit: { idProduit: p.idProduit }, contenant: { idContenant: p.idContenant }, quantite: 1 };

    const variants = [
      { label: 'standard',       payload: { client: { idClient }, grilleTarifaire: grille, commentaire: '', elementsBouteilles: [e1] } },
      { label: 'sans lot',       payload: { client: { idClient }, grilleTarifaire: grille, commentaire: '', elementsBouteilles: [e2] } },
      { label: 'avec date',      payload: { client: { idClient }, grilleTarifaire: grille, commentaire: '', dateCommande: new Date().toISOString().slice(0,10), elementsBouteilles: [e1] } },
    ];

    const results = [];
    for (const v of variants) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const r = await easybeerPost('/commande/enregistrer', v.payload);
        results.push({ label: v.label, ok: true, result: r });
        break;
      } catch (e) {
        results.push({ label: v.label, ok: false, error: e.message });
      }
    }
    res.json({ idClientType, firstProduit: p, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    // Vérifie le vrai type via detail (1 appel léger)
    const detail = await easybeerGet(`/parametres/client/detail/${idClient}`);
    const idClientType = detail?.type?.idClientType;
    const produits = await getProduitsClient(idClient);
    const p = produits[0];
    if (!p) return res.json({ error: 'Aucun produit trouvé', typeClient: detail?.type });
    const payload = {
      client: { idClient },
      grilleTarifaire: idClientType ? { idClientType } : undefined,
      commentaire: 'TEST',
      elementsBouteilles: [{ produit: { idProduit: p.idProduit }, contenant: { idContenant: p.idContenant }, lot: { idLot: p.idLot }, quantite: 1 }],
    };
    let result = null, error = null;
    try { result = await easybeerPost('/commande/enregistrer', payload); } catch (e) { error = { message: e.message, detail: e.detail }; }
    res.json({ idClientType, typeClient: detail?.type, firstProduit: p, payload, result, error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vendredi de la semaine en cours à minuit (heure de Paris), en millisecondes epoch.
// Si on est samedi ou dimanche, prend le vendredi de la semaine suivante.
function prochainVendredi() {
  const now = new Date();
  // Date du jour en heure de Paris
  const parisStr = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // YYYY-MM-DD
  const [y, m, d] = parisStr.split('-').map(Number);
  const jour = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dim … 5=ven 6=sam
  const delta = jour <= 5 ? 5 - jour : 6; // sam (6) → +6 = vendredi suivant
  const vendredi = new Date(Date.UTC(y, m - 1, d + delta));
  // Minuit heure de Paris : détermine l'offset Paris à cette date (heure d'été/hiver)
  const offsetTest = new Date(vendredi.getTime());
  const parisHour = parseInt(offsetTest.toLocaleString('en-US', { timeZone: 'Europe/Paris', hour: 'numeric', hour12: false }));
  const offsetH = (parisHour - offsetTest.getUTCHours() + 24) % 24; // 1 ou 2
  return vendredi.getTime() - offsetH * 60 * 60 * 1000;
}

// ---- Endpoints cache CDN : les données de référence passent par le cache Vercel
// pour économiser les appels EasyBeer (une seule origine remplit le cache pour tous)
app.get('/api/cache/types-client', async (req, res) => {
  try {
    const types = await getTypesClient();
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.json(types);
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

app.get('/api/cache/stock-index', async (req, res) => {
  try {
    const index = await getStockBouteilleIndex();
    res.set('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.json(Object.fromEntries(index));
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

app.get('/api/cache/prix/:idStock/:ict/:idClient', async (req, res) => {
  try {
    const { idStock, ict, idClient } = req.params;
    const data = await easybeerGet(`/parametres/prix/${idStock}/${ict}/${idClient}`);
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.json(data);
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

// Détail d'une commande (lignes produits résumées) — cache CDN 6h
app.get('/api/cache/detail/:idCommande', async (req, res) => {
  try {
    const det = await easybeerGet(`/commande/detail/${req.params.idCommande}`);
    const elements = [...(det.elementsBouteilles ?? []), ...(det.elementsFuts ?? [])].map(e => ({
      idContenant: e.stockProduit?.idContenant ?? null,
      quantite: e.quantite ?? 0,
      libelle: e.stockProduit?.libelle ?? e.designation ?? '',
    }));
    res.set('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.json({ elements });
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

// Coordonnées + contact d'un client — cache CDN 24h
app.get('/api/cache/client-infos/:idClient', async (req, res) => {
  try {
    const d = await easybeerGet(`/parametres/client/detail/${req.params.idClient}`);
    const contact = (d?.contacts ?? [])[0];
    res.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.json({
      lat: d?.adresse?.latitude ?? null,
      lng: d?.adresse?.longitude ?? null,
      adresse: d?.adresse?.complete ?? '',
      contact: contact ? [contact.nom, contact.telephone ?? contact.portable, contact.email].filter(Boolean).join(' — ') : '',
    });
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

// Raccourcit un libellé produit EasyBeer pour l'affichage :
// "GOAMBRE - Game Over Ambrée - 5.8° - Bouteille - 0.75L" → "Game Over Ambrée 0.75L"
function libelleCourt(libelle) {
  const parts = String(libelle ?? '').split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return libelle ?? '';
  // Code article en tête (majuscules/chiffres, pas d'espace) : on l'enlève
  if (/^[A-Z0-9]{3,12}$/.test(parts[0]) && parts.length > 2) parts.shift();
  const nom = parts.shift();
  const contenance = parts.find(p => /\d\s*L$/i.test(p)) ?? '';
  const fut = parts.some(p => /f[uû]t|keg/i.test(p));
  return [nom, fut ? 'Fût' : '', contenance].filter(Boolean).join(' ');
}

// Dernière commande d'un client, réduite au nécessaire pour les relances
app.get('/api/cache/derniere-commande/:idClient', async (req, res) => {
  try {
    const cmd = await easybeerGet(`/commande/derniere-commande/${req.params.idClient}`);
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.json({
      elementsBouteilles: (cmd.elementsBouteilles ?? []).map(e => ({
        quantite: e.quantite ?? 0,
        stockProduit: { libelle: libelleCourt(e.stockProduit?.libelle ?? e.produit?.libelle ?? '') },
      })),
    });
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

// Appel interne via le CDN Vercel (HIT = zéro requête EasyBeer)
function urlInterne(req, chemin) {
  const host = req.get('host');
  const proto = host?.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}${chemin}`;
}
async function fetchInterne(req, chemin) {
  const r = await fetch(urlInterne(req, chemin));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? `HTTP ${r.status}`), { status: r.status });
  return data;
}

// Stockage en mémoire des commandes passées (reset au redémarrage)
const historiqueCommandes = [];

// ---- Module Relances : analyse des habitudes clients ----

// Récupère toutes les commandes d'un état donné (paginé)
// Filtre exact envoyé par l'app EasyBeer sur la liste des commandes
const FILTRE_COMMANDES = {
  etats: [], etatsPaiement: [], typesPaiement: [], typesLivraison: [],
  idsClientsTypes: [], idsClientsTournees: [], idsCommerciaux: [],
  idsContenants: [], idsPointsRetrait: [], idsProduits: [],
  // inclureArchive : sans lui les commandes archivées (anciennes, soldées)
  // disparaissent des statistiques et le CA par client est sous-évalué
  contientSaisieLibre: false, inclureArchive: true,
  locationFut: false, locationMateriel: false, sansLocationMateriel: false,
  recherche: '', relancePaiement: false, retardPaiement: false,
  resteAPayer: null, total: null,
};

async function fetchCommandesEtat(etat = 'toutes', maxPages = 30) {
  const commandes = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await easybeerPost(
      `/commande/liste/${etat}?numeroPage=${page}&nombreParPage=100&colonneTri=-numero`,
      FILTRE_COMMANDES
    );
    const liste = data?.liste ?? data?.contenu ?? data?.content ?? (Array.isArray(data) ? data : []);
    commandes.push(...liste);
    const total = data?.nombreTotal ?? data?.totalElements ?? null;
    if (!liste.length || (total != null && commandes.length >= total)) break;
  }
  return commandes;
}

// Cache de l'analyse (30 min)
let relancesCache = null;
let relancesCacheExpiry = 0;

let relancesEnCours = null;
async function analyserClients(req) {
  if (relancesCache && Date.now() < relancesCacheExpiry) return relancesCache;
  if (!relancesEnCours) {
    relancesEnCours = analyserClientsInterne(req).finally(() => { relancesEnCours = null; });
  }
  try {
    return await relancesEnCours;
  } catch (err) {
    console.error('relances:', err.message);
    if (relancesCache) return relancesCache; // sert la version périmée plutôt qu'une erreur
    throw err;
  }
}

async function analyserClientsInterne(req) {

  // Toutes les commandes (l'app EasyBeer utilise l'état "toutes").
  // En cas d'échec on laisse remonter l'erreur : le cache périmé sera servi
  // plutôt qu'une analyse vide mise en cache comme si elle était valide.
  const toutes0 = await fetchCommandesEtat('toutes');
  if (!toutes0.length) {
    throw Object.assign(new Error('Aucune commande récupérée depuis EasyBeer'), { status: 503 });
  }
  let toutes = toutes0;
  // Exclut devis, annulées et clients particuliers de l'analyse
  const typesParticuliers = await getIdsTypesParticuliers();
  toutes = toutes.filter(c =>
    !c.estDevis && !c.estAnnulee &&
    !estParticulierParNom(c.client?.nom) &&
    !typesParticuliers.has(clientTypeMap.get(c.client?.idClient))
  );

  // Groupe par client
  const parClient = new Map();
  for (const c of toutes) {
    const idClient = c.client?.idClient ?? c.idClient;
    if (!idClient) continue;
    if (!parClient.has(idClient)) {
      parClient.set(idClient, { nom: c.client?.nom ?? `Client ${idClient}`, commandes: [] });
    }
    parClient.get(idClient).commandes.push({
      date: c.dateLivraisonReelle ?? c.dateCreation,
      totalHT: c.totalHT ?? 0,
      nombreElements: c.nombreElements ?? 0,
      synthese: c.syntheseConditionnement ?? '',
    });
  }

  const maintenant = Date.now();
  const JOUR = 24 * 60 * 60 * 1000;
  const clients = [];

  for (const [idClient, info] of parClient) {
    const cmds = info.commandes.filter(c => c.date).sort((a, b) => a.date - b.date);
    if (!cmds.length) continue;

    const derniere = cmds[cmds.length - 1];
    const dateDerniere = derniere.date;

    // Fréquence moyenne entre commandes (nécessite >= 2 commandes)
    let freqMoyenne = null;
    if (cmds.length >= 2) {
      const intervalles = [];
      for (let i = 1; i < cmds.length; i++) intervalles.push(cmds[i].date - cmds[i - 1].date);
      freqMoyenne = Math.round(intervalles.reduce((a, b) => a + b, 0) / intervalles.length / JOUR);
    }

    const volumeMoyen = Math.round(cmds.reduce((a, c) => a + c.nombreElements, 0) / cmds.length);
    const montantMoyen = Math.round(cmds.reduce((a, c) => a + c.totalHT, 0) / cmds.length * 100) / 100;

    // Produits les plus fréquents (depuis la synthèse de conditionnement)
    const produitsCount = {};
    for (const c of cmds) {
      for (const part of String(c.synthese).split(/[,;]/)) {
        const p = part.trim().replace(/^\d+\s*[x×]?\s*/i, '');
        if (p) produitsCount[p] = (produitsCount[p] ?? 0) + 1;
      }
    }
    const produitsHabituels = Object.entries(produitsCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);

    // Estimation prochaine commande + priorité
    let dateProchaine = null;
    let joursEcart = null; // >0 = retard, <0 = avance
    let priorite = 'pas_prioritaire';
    if (freqMoyenne != null && freqMoyenne > 0) {
      dateProchaine = dateDerniere + freqMoyenne * JOUR;
      joursEcart = Math.round((maintenant - dateProchaine) / JOUR);
      if (joursEcart > 0) priorite = 'urgent';
      else if (joursEcart >= -7) priorite = 'cette_semaine';
      else if (joursEcart >= -14) priorite = 'a_surveiller';
    }

    clients.push({
      idClient,
      nom: info.nom,
      nbCommandes: cmds.length,
      dateDerniereCommande: new Date(dateDerniere).toISOString().slice(0, 10),
      frequenceMoyenneJours: freqMoyenne,
      dateProchaineEstimee: dateProchaine ? new Date(dateProchaine).toISOString().slice(0, 10) : null,
      joursRetard: joursEcart,
      volumeMoyen,
      montantMoyenHT: montantMoyen,
      produitsHabituels,
      priorite,
    });
  }

  // Tri : urgent d'abord, puis par retard décroissant
  const ordre = { urgent: 0, cette_semaine: 1, a_surveiller: 2, pas_prioritaire: 3 };
  clients.sort((a, b) => (ordre[a.priorite] - ordre[b.priorite]) || ((b.joursRetard ?? -999) - (a.joursRetard ?? -999)));

  // Enrichit les clients prioritaires avec produits/volume de leur dernière commande
  // (la vue liste ne contient pas ces détails)
  const prioritaires = clients.filter(c => c.priorite !== 'pas_prioritaire').slice(0, 40);
  for (const c of prioritaires) {
    try {
      const cmd = await fetchInterne(req, `/api/cache/derniere-commande/${c.idClient}`);
      const elements = cmd.elementsBouteilles ?? [];
      c.volumeMoyen = elements.reduce((a, e) => a + (e.quantite ?? 0), 0);
      c.produitsHabituels = [...new Set(elements.map(e =>
        e.stockProduit?.libelle ?? e.produit?.libelle ?? ''
      ).filter(Boolean))].slice(0, 4);
    } catch {}
  }

  if (!clients.length) {
    throw Object.assign(new Error('Analyse des relances vide — données EasyBeer incomplètes'), { status: 503 });
  }
  relancesCache = { generePour: new Date().toISOString(), nbCommandesAnalysees: toutes.length, clients };
  relancesCacheExpiry = Date.now() + 30 * 60 * 1000;
  return relancesCache;
}

// ---- Module Pilotage : tableau de bord logistique ----

// Cache coordonnées clients (idClient → {lat, lng, adresse, contact})
const coordsClientCache = new Map();

async function getInfosClient(idClient) {
  const cached = coordsClientCache.get(idClient);
  if (cached && Date.now() < cached.expiry) return cached;
  try {
    const d = await easybeerGet(`/parametres/client/detail/${idClient}`);
    const contact = (d?.contacts ?? [])[0];
    const info = {
      lat: d?.adresse?.latitude ?? null,
      lng: d?.adresse?.longitude ?? null,
      adresse: d?.adresse?.complete ?? '',
      contact: contact ? [contact.nom, contact.telephone ?? contact.portable, contact.email].filter(Boolean).join(' — ') : '',
      expiry: Date.now() + 60 * 60 * 1000,
    };
    coordsClientCache.set(idClient, info);
    return info;
  } catch {
    return { lat: null, lng: null, adresse: '', contact: '' };
  }
}

// Détecte les clients particuliers (exclus du pilotage et des relances)
let idsTypesParticuliers = null;
async function getIdsTypesParticuliers() {
  if (idsTypesParticuliers) return idsTypesParticuliers;
  try {
    const types = await getTypesClient();
    idsTypesParticuliers = new Set(
      types.filter(t => (t.libelle ?? '').toLowerCase().includes('particulier')).map(t => t.idClientType)
    );
  } catch { idsTypesParticuliers = new Set(); }
  return idsTypesParticuliers;
}

function estParticulierParNom(nom) {
  return (nom ?? '').toLowerCase().includes('particulier');
}

function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let pilotageCache = null;
let pilotageCacheExpiry = 0;
// Contenu des commandes (change rarement) : cache 1h par idCommande
const detailCommandeCache = new Map();

let pilotageEnCours = null;
async function construirePilotage(req) {
  if (pilotageCache && Date.now() < pilotageCacheExpiry) return pilotageCache;
  // Mutex : les requêtes simultanées partagent la même construction
  if (!pilotageEnCours) {
    pilotageEnCours = construirePilotageInterne(req).finally(() => { pilotageEnCours = null; });
  }
  try {
    return await pilotageEnCours;
  } catch (err) {
    console.error('pilotage:', err.message);
    if (pilotageCache) return pilotageCache;
    throw err;
  }
}

async function construirePilotageInterne(req) {

  const JOUR = 24 * 60 * 60 * 1000;
  const debutAujourdhui = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' })).getTime();
  // Lundi de la semaine en cours (la semaine s'entend du lundi au dimanche)
  const jourSem = (new Date(debutAujourdhui).getUTCDay() + 6) % 7; // 0=lundi
  const debutSemaine = debutAujourdhui - jourSem * JOUR;
  const finSemaineLundi = debutSemaine + 7 * JOUR;
  // 1er du mois en cours (pour l'avancement mensuel, livraisons passées incluses)
  const dateParis = new Date(debutAujourdhui);
  const debutMois = Date.UTC(dateParis.getUTCFullYear(), dateParis.getUTCMonth(), 1);
  const debutPeriode = Math.min(debutSemaine, debutMois);

  // Contenants : contenance en litres + type fût
  const contenantMap = new Map();
  try {
    const contenants = await easybeerGet('/stock/bouteilles/contenants-disponibles');
    for (const c of (Array.isArray(contenants) ? contenants : [])) {
      contenantMap.set(c.idContenant, { contenance: c.contenance ?? 0, estFut: !!(c.estFut || c.estFutRecyclable), libelle: c.libelleAvecContenance ?? c.libelle });
    }
  } catch {}

  // Toutes les commandes (pros uniquement, les particuliers sont exclus)
  // En cas d'échec on lève l'erreur : le cache périmé sera servi à la place
  const toutes = await fetchCommandesEtat('toutes');
  const typesParticuliers = await getIdsTypesParticuliers();
  const valides = toutes.filter(c =>
    !c.estDevis && !c.estAnnulee &&
    !estParticulierParNom(c.client?.nom) &&
    !typesParticuliers.has(clientTypeMap.get(c.client?.idClient))
  );

  // Commandes concernées : livraison prévue depuis le début du mois (livraisons
  // passées incluses pour l'avancement), ou sans date et non soldées
  const aVenir = valides.filter(c =>
    (c.dateLivraisonPrevue && c.dateLivraisonPrevue >= debutPeriode) ||
    (!c.dateLivraisonPrevue && !c.estLivree && !c.estFacturee && !c.estArchivee)
  );

  // Enrichit les commandes : produits + coordonnées client.
  // Priorité aux commandes de la semaine puis au reste ; budget de nouveaux
  // appels détail limité par exécution (le cache se remplit progressivement)
  const livraisons = [];
  let echecsDetail = 0;
  const erreursDetail = [];
  const selection = aVenir
    .sort((a, b) => {
      const aSem = a.dateLivraisonPrevue >= debutSemaine ? 0 : 1;
      const bSem = b.dateLivraisonPrevue >= debutSemaine ? 0 : 1;
      return aSem - bSem || (b.dateLivraisonPrevue ?? 0) - (a.dateLivraisonPrevue ?? 0);
    })
    .slice(0, 120);

  // Passe 1 : le contenu des commandes (bouteilles) — via le cache CDN
  // (persistant entre les instances : HIT = zéro appel EasyBeer)
  const volumesParCommande = new Map();
  for (const c of selection) {
    let volInfo = detailCommandeCache.get(c.idCommande);
    if (!volInfo) {
      for (let essai = 0; essai < 2 && !volInfo; essai++) {
        try {
          const { elements } = await fetchInterne(req, `/api/cache/detail/${c.idCommande}`);
          const produits = [];
          let litres = 0, b33 = 0, b75 = 0, futs = 0, bouteilles = 0;
          for (const e of elements) {
            const cont = contenantMap.get(e.idContenant) ?? { contenance: 0, estFut: false };
            const q = e.quantite ?? 0;
            litres += cont.contenance * q;
            if (cont.estFut) futs += q;
            else {
              bouteilles += q;
              if (Math.abs(cont.contenance - 0.33) < 0.01) b33 += q;
              else if (Math.abs(cont.contenance - 0.75) < 0.01) b75 += q;
            }
            produits.push({ libelle: e.libelle, quantite: q, contenance: cont.contenance, estFut: cont.estFut });
          }
          volInfo = { produits, litres, b33, b75, futs, bouteilles };
          detailCommandeCache.set(c.idCommande, volInfo);
        } catch (e) {
          if (erreursDetail.length < 5) erreursDetail.push({ idCommande: c.idCommande, essai, message: e.message?.slice(0, 200) });
          if (essai === 0) await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
    if (!volInfo) { echecsDetail++; volInfo = { produits: [], litres: 0, b33: 0, b75: 0, futs: 0, bouteilles: 0 }; }
    volumesParCommande.set(c.idCommande, volInfo);
  }

  // Passe 2 : coordonnées et contact des clients — via le cache CDN
  // (uniquement livraisons futures, la carte n'affiche pas le passé)
  for (const c of selection) {
    const idClient = c.client?.idClient;
    const { produits, litres, b33, b75, futs, bouteilles } = volumesParCommande.get(c.idCommande);
    const future = !c.dateLivraisonPrevue || c.dateLivraisonPrevue >= debutAujourdhui;
    let infos = {};
    if (idClient && future) {
      try { infos = await fetchInterne(req, `/api/cache/client-infos/${idClient}`); } catch {}
    }
    livraisons.push({
      idCommande: c.idCommande,
      numero: c.numero,
      client: { id: idClient, nom: c.client?.nom ?? '' },
      dateLivraison: c.dateLivraisonPrevue ?? null,
      etat: c.etat?.libelle ?? '',
      confirmee: !!(c.estValidee || c.estEnPreparation || c.estPrete || c.estEnLivraison),
      totalHT: c.totalHT ?? 0,
      lat: infos.lat, lng: infos.lng, adresse: infos.adresse, contact: infos.contact,
      produits, litres: Math.round(litres * 100) / 100, b33, b75, futs, bouteilles,
    });
  }

  // KPI — la semaine va du lundi au dimanche
  const dansJours = n => debutAujourdhui + n * JOUR;
  const moisCourant = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7);
  const estCeMois = t => t && new Date(t).toISOString().slice(0, 7) === moisCourant;

  const cmdAujourdhui = livraisons.filter(l => l.dateLivraison && l.dateLivraison >= debutAujourdhui && l.dateLivraison < dansJours(1));
  const cmdSemaine = livraisons.filter(l => l.dateLivraison && l.dateLivraison >= debutSemaine && l.dateLivraison < finSemaineLundi);
  const cmdMois = livraisons.filter(l => estCeMois(l.dateLivraison));
  const cmdAVenir = livraisons.filter(l => !l.dateLivraison || l.dateLivraison >= debutAujourdhui);

  const totVol = arr => arr.reduce((a, l) => ({ litres: a.litres + l.litres, b33: a.b33 + l.b33, b75: a.b75 + l.b75, futs: a.futs + l.futs, bouteilles: a.bouteilles + l.bouteilles }), { litres: 0, b33: 0, b75: 0, futs: 0, bouteilles: 0 });
  const volumesTotal = totVol(livraisons);

  // Clients actifs = ayant commandé dans les 6 derniers mois
  const ilYA6Mois = debutAujourdhui - 182 * JOUR;
  const clientsActifs = new Set(valides.filter(c => (c.dateCreation ?? 0) >= ilYA6Mois).map(c => c.client?.idClient)).size;

  // Tournées suggérées : regroupement glouton par proximité (< 8 km), par jour
  const tournees = [];
  const parJour = new Map();
  for (const l of livraisons.filter(l => l.lat && l.lng && l.dateLivraison)) {
    const j = new Date(l.dateLivraison).toISOString().slice(0, 10);
    if (!parJour.has(j)) parJour.set(j, []);
    parJour.get(j).push(l);
  }
  for (const [jour, pts] of parJour) {
    const restants = [...pts];
    while (restants.length) {
      const groupe = [restants.shift()];
      for (let i = restants.length - 1; i >= 0; i--) {
        if (groupe.some(g => haversineKm(g, restants[i]) < 8)) groupe.push(...restants.splice(i, 1));
      }
      let km = 0;
      for (let i = 1; i < groupe.length; i++) km += haversineKm(groupe[i - 1], groupe[i]);
      km = Math.round(km * 10) / 10;
      tournees.push({
        jour,
        nbLivraisons: groupe.length,
        clients: groupe.map(g => g.client.nom),
        kmEstimes: km,
        dureeEstimeeMin: Math.round(km / 40 * 60 + groupe.length * 15),
        litres: Math.round(groupe.reduce((a, g) => a + g.litres, 0)),
        caHT: Math.round(groupe.reduce((a, g) => a + g.totalHT, 0)),
      });
    }
  }
  tournees.sort((a, b) => a.jour.localeCompare(b.jour));

  // Alertes
  const alertes = [];
  for (const t of tournees) {
    if (t.nbLivraisons > 8) alertes.push({ type: 'tournee_chargee', message: `Tournée très chargée le ${t.jour} : ${t.nbLivraisons} livraisons` });
    if (t.nbLivraisons >= 3) alertes.push({ type: 'zone', message: `${t.nbLivraisons} livraisons dans la même zone le ${t.jour} (${t.kmEstimes} km) — tournée recommandée` });
  }
  for (const l of livraisons) {
    if (!l.produits.length) alertes.push({ type: 'incomplete', message: `Commande n°${l.numero} (${l.client.nom}) sans produits détectés` });
  }
  const litresParJour = [...parJour.entries()].map(([j, pts]) => ({ j, litres: pts.reduce((a, p) => a + p.litres, 0) }));
  const moyLitres = litresParJour.reduce((a, x) => a + x.litres, 0) / (litresParJour.length || 1);
  for (const x of litresParJour) {
    if (moyLitres > 0 && x.litres > 2 * moyLitres) alertes.push({ type: 'volume', message: `Volume inhabituel le ${x.j} : ${Math.round(x.litres)} L (moyenne ${Math.round(moyLitres)} L)` });
  }

  // Statistiques historiques
  const parSemaine = new Map();
  for (const c of valides) {
    if (!c.dateCreation) continue;
    const d = new Date(c.dateCreation);
    const lundi = new Date(d); lundi.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = lundi.toISOString().slice(0, 10);
    parSemaine.set(key, (parSemaine.get(key) ?? 0) + 1);
  }
  const commandesParSemaine = [...parSemaine.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12)
    .map(([semaine, nb]) => ({ semaine, nb }));

  // --- Canal de vente par client : type EasyBeer d'abord, mots-clés du nom sinon ---
  const typesTous = await getTypesClient().catch(() => []);
  const libelleType = new Map(typesTous.map(t => [t.idClientType, (t.libelle ?? '').toLowerCase()]));
  let typeParClient = new Map();
  try {
    const listeClients = await fetchInterne(req, '/api/clients');
    typeParClient = new Map(listeClients.map(c => [c.id, c.idClientType]));
  } catch {}
  const canalDe = (idClient, nom) =>
    canalParLibelleEtNom(libelleType.get(typeParClient.get(idClient) ?? clientTypeMap.get(idClient)), nom);

  // Historique léger de toutes les commandes : sert aux comparaisons de périodes côté client
  const commandesLight = valides.map(c => ({
    t: c.dateCreation ?? c.dateLivraisonPrevue ?? null,
    dl: c.dateLivraisonPrevue ?? null,
    id: c.client?.idClient ?? null,
    nom: c.client?.nom ?? '',
    canal: canalDe(c.client?.idClient, c.client?.nom),
    ht: Math.round((c.totalHT ?? 0) * 100) / 100,
  })).filter(c => c.t);

  // Canal aussi sur les livraisons enrichies (croisement produit × canal, filtres)
  for (const l of livraisons) l.canal = canalDe(l.client.id, l.client.nom);

  // --- Analyse clients : CA cumulé, fréquence, tendance, statut ---
  const moisCle = t => new Date(t).toISOString().slice(0, 7);
  // 24 derniers mois glissants (du plus ancien au plus récent)
  const moisRecents = [];
  {
    const d = new Date(debutAujourdhui);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 23);
    for (let i = 0; i < 24; i++) {
      moisRecents.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  const dansMois = new Set(moisRecents);

  const fiches = new Map(); // idClient (ou nom) → fiche
  for (const c of valides) {
    const nom = c.client?.nom;
    if (!nom) continue;
    const cle = c.client?.idClient ?? nom;
    let f = fiches.get(cle);
    if (!f) {
      f = { id: c.client?.idClient ?? null, nom, caHT: 0, nbCommandes: 0,
            premiere: null, derniere: null, parMois: {}, dates: [] };
      fiches.set(cle, f);
    }
    const ca = c.totalHT ?? 0;
    f.caHT += ca;
    f.nbCommandes++;
    const t = c.dateCreation ?? c.dateLivraisonPrevue ?? null;
    if (t) {
      f.dates.push(t);
      if (f.premiere === null || t < f.premiere) f.premiere = t;
      if (f.derniere === null || t > f.derniere) f.derniere = t;
      const m = moisCle(t);
      if (dansMois.has(m)) f.parMois[m] = Math.round(((f.parMois[m] ?? 0) + ca) * 100) / 100;
    }
  }

  const il12Mois = debutAujourdhui - 365 * JOUR;
  const il24Mois = debutAujourdhui - 730 * JOUR;
  // Fenêtres glissantes 12 mois / 12 mois précédents
  for (const c of valides) {
    const cle = c.client?.idClient ?? c.client?.nom;
    const f = fiches.get(cle);
    if (!f) continue;
    const t = c.dateCreation ?? c.dateLivraisonPrevue ?? null;
    if (!t) continue;
    const ca = c.totalHT ?? 0;
    if (t >= il12Mois) f.ca12 = (f.ca12 ?? 0) + ca;
    else if (t >= il24Mois) f.ca12Prec = (f.ca12Prec ?? 0) + ca;
  }

  const caTotalClients = [...fiches.values()].reduce((a, f) => a + f.caHT, 0);
  const arrondi = n => Math.round(n * 100) / 100;

  const clientsStats = [...fiches.values()].map(f => {
    const ca12 = f.ca12 ?? 0, ca12Prec = f.ca12Prec ?? 0;
    const joursDepuis = f.derniere ? Math.max(0, Math.floor((debutAujourdhui - f.derniere) / JOUR)) : null;
    // Fréquence : intervalle moyen entre deux commandes
    let frequenceJours = null;
    if (f.nbCommandes >= 2 && f.premiere && f.derniere && f.derniere > f.premiere) {
      frequenceJours = Math.round((f.derniere - f.premiere) / JOUR / (f.nbCommandes - 1));
    }
    // Statut : inactif au-delà de 3× sa fréquence habituelle (ou 180 j par défaut)
    const seuilRisque = frequenceJours ? Math.max(frequenceJours * 2, 45) : 90;
    const seuilInactif = frequenceJours ? Math.max(frequenceJours * 3, 90) : 180;
    let statut = 'actif';
    if (joursDepuis === null) statut = 'inconnu';
    else if (joursDepuis > seuilInactif) statut = 'inactif';
    else if (joursDepuis > seuilRisque) statut = 'risque';
    return {
      id: f.id, nom: f.nom,
      canal: canalDe(f.id, f.nom),
      caHT: arrondi(f.caHT),
      nbCommandes: f.nbCommandes,
      panierMoyen: arrondi(f.caHT / f.nbCommandes),
      partCA: caTotalClients > 0 ? Math.round(f.caHT / caTotalClients * 1000) / 10 : 0,
      premiere: f.premiere, derniere: f.derniere,
      joursDepuis, frequenceJours, statut,
      ca12: arrondi(ca12), ca12Prec: arrondi(ca12Prec),
      evolution: ca12Prec > 0 ? Math.round((ca12 - ca12Prec) / ca12Prec * 1000) / 10 : null,
      parMois: f.parMois,
    };
  }).sort((a, b) => b.caHT - a.caHT);

  // CA global par mois (24 derniers mois) — courbe de tendance
  const caParMois = moisRecents.map(m => ({
    mois: m,
    caHT: arrondi(clientsStats.reduce((a, c) => a + (c.parMois[m] ?? 0), 0)),
    clients: clientsStats.filter(c => c.parMois[m]).length,
  }));

  // Concentration (Pareto) sur le CA cumulé
  const cumul = [];
  let acc = 0;
  for (const c of clientsStats) { acc += c.caHT; cumul.push(acc); }
  const partTop = n => caTotalClients > 0 && cumul.length
    ? Math.round((cumul[Math.min(n, cumul.length) - 1] / caTotalClients) * 1000) / 10 : 0;

  const syntheseClients = {
    caTotalHT: Math.round(caTotalClients),
    nbClients: clientsStats.length,
    nbActifs: clientsStats.filter(c => c.statut === 'actif').length,
    nbRisque: clientsStats.filter(c => c.statut === 'risque').length,
    nbInactifs: clientsStats.filter(c => c.statut === 'inactif').length,
    panierMoyen: clientsStats.length
      ? arrondi(caTotalClients / clientsStats.reduce((a, c) => a + c.nbCommandes, 0)) : 0,
    partTop5: partTop(5),
    partTop10: partTop(10),
    partTop20: partTop(20),
  };

  const topClients = clientsStats.slice(0, 8).map(c => ({ nom: c.nom, caHT: Math.round(c.caHT) }));

  const qteParProduit = new Map();
  for (const l of livraisons) for (const p of l.produits) {
    qteParProduit.set(p.libelle, (qteParProduit.get(p.libelle) ?? 0) + p.quantite);
  }
  const topProduits = [...qteParProduit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([libelle, qte]) => ({ libelle, qte }));

  pilotageCache = {
    genere: new Date().toISOString(),
    incomplet: echecsDetail > 0,
    erreursDetail,
    kpi: {
      commandesAVenir: cmdAVenir.length,
      commandesAujourdhui: cmdAujourdhui.length,
      commandesSemaine: cmdSemaine.length,
      commandesMois: cmdMois.length,
      clientsAujourdhui: new Set(cmdAujourdhui.map(l => l.client.id)).size,
      clientsSemaine: new Set(cmdSemaine.map(l => l.client.id)).size,
      clientsActifs,
      pointsLivraison: livraisons.filter(l => l.lat).length,
      caPrevisionnelHT: Math.round(livraisons.reduce((a, l) => a + l.totalHT, 0)),
    },
    volumes: { ...volumesTotal, litres: Math.round(volumesTotal.litres), colis: livraisons.reduce((a, l) => a + l.produits.length, 0) },
    livraisons,
    tournees,
    alertes,
    stats: { commandesParSemaine, topClients, topProduits, caParMois, syntheseClients, clients: clientsStats, commandes: commandesLight },
  };
  // Si des détails ont échoué (saturation EasyBeer), cache court pour retenter vite
  pilotageCacheExpiry = Date.now() + (echecsDetail > 0 ? 3 : 30) * 60 * 1000;
  return pilotageCache;
}

app.get('/api/pilotage', async (req, res) => {
  try {
    const data = await construirePilotage(req);
    // Cache CDN court si des données sont incomplètes, pour retenter rapidement
    res.set('Cache-Control', data.incomplet
      ? 'public, s-maxage=300, stale-while-revalidate=3600'
      : 'public, s-maxage=3600, stale-while-revalidate=604800');
    res.json(data);
  } catch (err) {
    console.error('GET /api/pilotage', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// --- API Relances ---
app.get('/api/relances', async (req, res) => {
  try {
    const data = await analyserClients(req);
    res.set('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.json(data);
  } catch (err) {
    console.error('GET /api/relances', err.message, err.detail);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// Debug : une page brute de la liste des commandes
app.get('/api/debug-liste/:etat', async (req, res) => {
  try {
    const data = await easybeerPost(`/commande/liste/${req.params.etat}?numeroPage=1&nombreParPage=3&colonneTri=-numero`, FILTRE_COMMANDES);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Debug : historique de commande d'un client (POST avec periode)
app.get('/api/debug-historique/:idClient', async (req, res) => {
  try {
    const fin = new Date();
    const debut = new Date(fin.getTime() - 365 * 24 * 60 * 60 * 1000);
    const data = await easybeerPost(
      `/parametres/client/historique-commande/${req.params.idClient}`,
      { dateDebut: debut.toISOString(), dateFin: fin.toISOString() }
    );
    const str = JSON.stringify(data);
    res.json({ keys: Object.keys(data ?? {}), taille: str.length, extrait: str.slice(0, 2000) });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.detail?.slice?.(0, 300) });
  }
});

// Debug : teste plusieurs variantes de filtre/tri pour la liste des commandes
app.get('/api/debug-liste-variants', async (req, res) => {
  const filtreComplet = {
    etats: [], etatsPaiement: [], tags: [], typesLivraison: [], typesPaiement: [],
    idsClientsTournees: [], idsClientsTypes: [], idsCommerciaux: [], idsContenants: [],
    idsPointsRetrait: [], idsProduits: [], recherche: '', inclureArchive: false,
  };
  const variants = [
    { label: 'tri=dateCreation filtre vide', q: 'colonneTri=dateCreation', body: {} },
    { label: 'tri=dateCreation filtre complet', q: 'colonneTri=dateCreation', body: filtreComplet },
    { label: 'tri=numero filtre complet', q: 'colonneTri=numero', body: filtreComplet },
    { label: 'tri=DATE_CREATION filtre complet', q: 'colonneTri=DATE_CREATION', body: filtreComplet },
    { label: 'tri vide filtre complet', q: 'colonneTri=', body: filtreComplet },
  ];
  const results = [];
  for (const v of variants) {
    try {
      const data = await easybeerPost(`/commande/liste/TOUTES?${v.q}&nombreParPage=2&numeroPage=0`, v.body);
      results.push({ label: v.label, ok: true, keys: Object.keys(data ?? {}), sample: JSON.stringify(data).slice(0, 300) });
      break;
    } catch (e) {
      results.push({ label: v.label, ok: false, error: e.message.slice(0, 200) });
    }
    await new Promise(r => setTimeout(r, 150));
  }
  res.json(results);
});

// Construit le payload ModeleCommande attendu par EasyBeer
async function construirePayloadCommande(req, body, natureOperations) {
  {
    const { idClient, idClientType, lignes, commentaire, adresseLivraison } = body;
    const payload = {};
    // Grille tarifaire complète — via le cache CDN (zéro appel EasyBeer si HIT)
    const typesClient = await fetchInterne(req, '/api/cache/types-client');
    const grilleTarifaire = typesClient.find(t => t.idClientType === idClientType) ?? { idClientType };

    const indexObj = await fetchInterne(req, '/api/cache/stock-index');
    const index = new Map(Object.entries(indexObj));

    // Construit chaque élément avec stock complet + prix réel du client
    const elementsBouteilles = [];
    let totalHT = 0;
    let tva = 0;
    let tauxTVARef = grilleTarifaire.tauxTVA;
    for (const l of lignes) {
      const stock = index.get(`${l.idProduit}-${l.idContenant}-${l.idLot ?? 1}`) ?? null;
      const idStockBouteille = stock?.idStockBouteille ?? l.idStockBouteille;
      if (!idStockBouteille) {
        throw Object.assign(new Error(`Stock introuvable pour le produit ${l.idProduit}`), { status: 400 });
      }
      let prixHT = 0;
      try {
        const prixData = await fetchInterne(req, `/api/cache/prix/${idStockBouteille}/${idClientType}/${idClient}`);
        prixHT = prixData?.prixHT ?? 0;
      } catch {}
      const prixTotalHT = Math.round(prixHT * l.quantite * 100) / 100;
      const taux = (stock?.tauxTVA?.taux ?? 20) / 100;
      totalHT += prixTotalHT;
      tva += prixTotalHT * taux;
      if (stock?.tauxTVA) tauxTVARef = stock.tauxTVA;

      elementsBouteilles.push({
        tauxTVA: stock?.tauxTVA ?? undefined,
        stockProduit: stock ?? undefined,
        stockBouteille: { idStockBouteille },
        valeurRemise: 0,
        participation: 0,
        participationUnitaire: 0,
        prixLotHT: prixHT,
        prixTotalHT,
        quantite: l.quantite,
      });
    }
    totalHT = Math.round(totalHT * 100) / 100;
    tva = Math.round(tva * 100) / 100;

    Object.assign(payload, {
      client: { type: {}, idClient },
      grilleTarifaire,
      commentaire: commentaire ?? '',
      // Note visible sur le bon de livraison (indications pour le livreur)
      informationLivraison: commentaire ?? '',
      commentaireClient: commentaire ?? '',
      // Livraison par nos soins, le vendredi de la semaine en cours
      typeLivraison: { code: 'SELF', libelle: 'Livraison par nos soins' },
      dateLivraisonPrevue: prochainVendredi(),
      dateLivraisonPrevueFormulaire: prochainVendredi(),
      adresseLivraison: adresseLivraison ?? {},
      natureOperations: natureOperations ?? { code: 'LIVRAISONS_BIENS', libelle: 'Livraisons de biens' },
      droitSuspendu: false,
      echangeHorsUE: false,
      deductionsAvoirs: [],
      listeTropPercus: [],
      elementsContenants: [],
      elementsFuts: [],
      elementsLocations: [],
      elementsAutres: [],
      elementsMatieresPremieres: [],
      elementsSaisieLibre: [],
      elementsBouteilles,
      fraisLivraisonHT: 0,
      tauxTVAFraisLivraison: tauxTVARef,
      remiseTotale: 0,
      participationTotale: 0,
      totalConsigne: 0,
      poids: 0,
      totalHT,
      tva,
      total: Math.round((totalHT + tva) * 100) / 100,
      tags: [],
    });
    return payload;
  }
}

// --- Création de commande ---
app.post('/api/commande', async (req, res) => {
  let payload = {};
  try {
    const { idClient, nomClient, lignes, commentaire } = req.body;
    if (!idClient || !Array.isArray(req.body.lignes) || req.body.lignes.length === 0) {
      return res.status(400).json({ error: 'idClient et lignes sont requis' });
    }
    payload = await construirePayloadCommande(req, req.body);
    console.log('POST /api/commande payload:', JSON.stringify(payload));
    const result = await easybeerPost('/commande/enregistrer', payload);

    // Sauvegarde dans l'historique local
    historiqueCommandes.push({
      date: new Date().toISOString(),
      idClient,
      nomClient: nomClient ?? `Client ${idClient}`,
      commentaire: commentaire ?? '',
      lignes,
      reference: result.map?.numero ?? result.map?.id ?? '',
    });

    res.json(result);
  } catch (err) {
    console.error('POST /api/commande', err.message, err.detail);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail, payloadEnvoye: payload });
  }
});

// --- Export PDF récapitulatif des commandes ---
app.get('/api/commandes-pdf', (req, res) => {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="commandes.pdf"');
  doc.pipe(res);

  // En-tête
  doc.fontSize(18).font('Helvetica-Bold').text('Récapitulatif des commandes', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(`Généré le ${new Date().toLocaleString('fr-FR')}`, { align: 'center' });
  doc.moveDown(1.5);

  if (historiqueCommandes.length === 0) {
    doc.fontSize(12).text('Aucune commande enregistrée.', { align: 'center' });
    doc.end();
    return;
  }

  for (const cmd of historiqueCommandes) {
    const dateStr = new Date(cmd.date).toLocaleString('fr-FR');
    doc.fontSize(12).font('Helvetica-Bold').text(`${cmd.nomClient}`, { continued: true });
    doc.font('Helvetica').fontSize(10).text(`  —  ${dateStr}`);
    if (cmd.reference) doc.fontSize(10).text(`Référence : ${cmd.reference}`);
    if (cmd.commentaire) doc.fontSize(10).text(`Note : ${cmd.commentaire}`);

    for (const l of cmd.lignes) {
      const label = l.libelle ? `${l.libelle} ${l.contenant ?? ''}`.trim() : `Produit #${l.idProduit}`;
      const gencode = l.gtin ? `  [${l.gtin}]` : '';
      doc.fontSize(10).text(`  • ${label} — qté : ${l.quantite}${gencode}`);
    }
    doc.moveDown(0.8);

    // Trait de séparation
    if (historiqueCommandes.indexOf(cmd) < historiqueCommandes.length - 1) {
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.5);
    }
  }

  doc.end();
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
}

export default app;
