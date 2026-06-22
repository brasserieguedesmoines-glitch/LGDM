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

    // Récupération des prix en parallèle
    const avecPrix = await Promise.all(produits.map(async p => {
      try {
        const tarifs = await easybeerGet(
          `/parametres/grille-tarifaire/${p.idContenant}/${p.idProduit}/${p.idLot}`
        );
        // On prend le prix du client direct (idClient) ou à défaut le premier tarif disponible
        const ligneClient = Array.isArray(tarifs)
          ? (tarifs.find(t => t.idClient === idClient) ?? tarifs[0])
          : null;
        return { ...p, prixHT: ligneClient?.prixHT ?? null, typeClient: ligneClient?.typeClient ?? null };
      } catch {
        return { ...p, prixHT: null };
      }
    }));

    res.json(avecPrix);
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
        prixUnitaire: l.prixHT,
      })),
    };
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
