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

// Cache grille tarifaire (chargée une fois, valide 1h)
let cache = null;
let cacheExpiry = 0;

async function getGrille() {
  if (!cache || Date.now() > cacheExpiry) {
    cache = await easybeerGet('/parametres/grille-tarifaire/matrice/client');
    cacheExpiry = Date.now() + 60 * 60 * 1000;
  }
  return cache;
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

  // Si idClientType trouvé, reteste avec
  if (idClientType) {
    try {
      const r = await easybeerPost('/commande/enregistrer', {
        client: { idClient }, grilleTarifaire: { idClientType }, commentaire: 'TEST', elementsBouteilles: [ligne],
      });
      results.push({ label: 'grilleTarifaire depuis derniere commande', ok: true, result: r });
    } catch (e) {
      results.push({ label: 'grilleTarifaire depuis derniere commande', ok: false, error: e.message, detail: e.detail });
    }
  }

  res.json({ typeClient, idClientType, grilleTarifaireExistante, results });
});

// --- Clients ---
// Source : grille tarifaire → data.clients[].modeleClient
app.get('/api/clients', async (req, res) => {
  try {
    const data = await getGrille();
    const clients = data.clients
      .filter(c => c.modeleClient.actif && !c.modeleClient.supprime)
      .map(c => ({ id: c.modeleClient.idClient, nom: c.modeleClient.nom }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    res.json(clients);
  } catch (err) {
    console.error('GET /api/clients', err.message);
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// --- Produits + prix pour un client ---
// Source : grille tarifaire → client.tarifs × conditionnements
// Prix : GET /parametres/grille-tarifaire/{idContenant}/{idProduit}/{idLot}
app.get('/api/tarifs/:idClient', async (req, res) => {
  try {
    const idClient = parseInt(req.params.idClient);
    const data = await getGrille();

    // Map des conditionnements : "idProduit-idContenant-idLot" → infos
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

    // Produits du client (dédupliqués)
    const clientData = data.clients.find(c => c.modeleClient.idClient === idClient);
    if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

    const seen = new Set();
    const produits = [];
    for (const t of clientData.tarifs) {
      const key = `${t.modeleProduit.idProduit}-${t.modeleContenant.idContenant}-${t.modeleLot.idLot}`;
      if (!seen.has(key) && condMap[key]) {
        seen.add(key);
        produits.push(condMap[key]);
      }
    }

    res.json(produits);
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

// --- Création de commande ---
app.post('/api/commande', async (req, res) => {
  try {
    const { idClient, lignes, commentaire } = req.body;
    if (!idClient || !Array.isArray(lignes) || lignes.length === 0) {
      return res.status(400).json({ error: 'idClient et lignes sont requis' });
    }
    const payload = {
      idClient,
      commentaire: commentaire ?? '',
      lignesCommande: lignes.map(l => ({
        idProduit: l.idProduit,
        idContenant: l.idContenant,
        idLot: l.idLot ?? 1,
        quantite: l.quantite,
      })),
    };
    console.log('POST /api/commande payload:', JSON.stringify(payload));
    const result = await easybeerPost('/commande/enregistrer', payload);
    res.json(result);
  } catch (err) {
    console.error('POST /api/commande', err.message, err.detail);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
}

export default app;
