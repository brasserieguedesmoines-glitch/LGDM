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

// --- Debug ---
app.get('/api/debug', async (req, res) => {
  const results = [];

  // 1. Profil utilisateur courant (pour récupérer l'idUtilisateur)
  try {
    const r = await fetch(`${BASE_URL}/utilisateur/profil`, { headers: easybeerHeaders() });
    const body = await r.text();
    results.push({ path: 'GET /utilisateur/profil', status: r.status, preview: body.slice(0, 400) });
  } catch (e) { results.push({ path: 'GET /utilisateur/profil', status: 'error', preview: e.message }); }

  // 2. POST liste clients paginée (corps minimal)
  try {
    const r = await fetch(`${BASE_URL}/parametres/client/liste`, {
      method: 'POST', headers: easybeerHeaders(), body: JSON.stringify({ page: 0, taille: 20 }),
    });
    const body = await r.text();
    results.push({ path: 'POST /parametres/client/liste', status: r.status, preview: body.slice(0, 500) });
  } catch (e) { results.push({ path: 'POST /parametres/client/liste', status: 'error', preview: e.message }); }

  // 3. Grille tarifaire complète (1er élément avec prix)
  try {
    const r = await fetch(`${BASE_URL}/parametres/grille-tarifaire/matrice/client`, { headers: easybeerHeaders() });
    const data = await r.json();
    const premier = data?.conditionnements?.[0];
    results.push({ path: 'GET /parametres/grille-tarifaire/matrice/client', status: r.status, premierElement: premier });
  } catch (e) { results.push({ path: 'GET grille-tarifaire', status: 'error', preview: e.message }); }

  res.json(results);
});

// --- Clients ---
// GET /parametres/client/tournee → listeTourneeClient
app.get('/api/clients', async (req, res) => {
  try {
    const data = await easybeerGet('/parametres/client/tournee');
    const liste = Array.isArray(data) ? data : (data.content ?? data.liste ?? data);
    res.json(liste);
  } catch (err) {
    console.error('GET /api/clients', err.message);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// --- Produits disponibles avec tarifs par client ---
// GET /parametres/grille-tarifaire/matrice/client?idClient=X
app.get('/api/tarifs/:idClient', async (req, res) => {
  try {
    const data = await easybeerGet(`/parametres/grille-tarifaire/matrice/client?idClient=${req.params.idClient}`);
    const liste = Array.isArray(data) ? data : (data.content ?? data.lignes ?? data.tarifs ?? data);
    res.json(liste);
  } catch (err) {
    console.error('GET /api/tarifs', err.message);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// --- Dernière commande client ---
app.get('/api/derniere-commande/:idClient', async (req, res) => {
  try {
    const data = await easybeerGet(`/commande/derniere-commande/${req.params.idClient}`);
    res.json(data);
  } catch (err) {
    console.error('GET /api/derniere-commande', err.message);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// --- Création de commande ---
app.post('/api/commande', async (req, res) => {
  try {
    const { idClient, lignes, commentaire } = req.body;
    if (!idClient || !Array.isArray(lignes) || lignes.length === 0) {
      return res.status(400).json({ error: 'idClient et lignes sont requis' });
    }
    const payload = buildCommandePayload({ idClient, lignes, commentaire });
    const result = await easybeerPost('/commande/enregistrer', payload);
    res.json(result);
  } catch (err) {
    console.error('POST /api/commande', err.message, err.detail);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

function buildCommandePayload({ idClient, lignes, commentaire }) {
  return {
    idClient,
    commentaire: commentaire ?? '',
    lignesCommande: lignes.map(l => ({
      idProduit: l.idProduit,
      quantite: l.quantite,
      prixUnitaire: l.prixUnitaire,
    })),
  };
}

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
}

export default app;
