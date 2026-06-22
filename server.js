import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BASE_URL = process.env.EASYBEER_BASE_URL || 'https://api.easybeer.fr';
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
  if (!res.ok) throw Object.assign(new Error(`EasyBeer ${res.status}`), { status: res.status });
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

// --- Clients ---
// TODO : confirmer l'endpoint exact dans Swagger (controleur-partenaire ou controleur-referentiel)
// Candidats à tester dans l'ordre :
//   GET /partenaire/liste  (controleur-partenaire)
//   GET /referentiel/client/liste  (controleur-referentiel)
app.get('/api/clients', async (req, res) => {
  try {
    const data = await easybeerGet('/partenaire/liste');
    // Normalise la réponse : on attend un tableau ou { content: [...] }
    const liste = Array.isArray(data) ? data : (data.content ?? data.liste ?? data);
    res.json(liste);
  } catch (err) {
    console.error('GET /api/clients', err.message);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// --- Produits / tarifs par client ---
// TODO : confirmer l'endpoint exact dans Swagger
// Candidats à tester dans l'ordre :
//   GET /referentiel/tarif/client/{idClient}
//   GET /stock/tarif/{idClient}
//   GET /commande/tarif/{idClient}
app.get('/api/tarifs/:idClient', async (req, res) => {
  try {
    const data = await easybeerGet(`/referentiel/tarif/client/${req.params.idClient}`);
    const liste = Array.isArray(data) ? data : (data.content ?? data.lignes ?? data);
    res.json(liste);
  } catch (err) {
    console.error('GET /api/tarifs', err.message);
    res.status(err.status ?? 502).json({ error: err.message, detail: err.detail });
  }
});

// --- Dernière commande client (pour pré-remplir le panier) ---
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
// Schéma attendu par POST /commande/enregistrer à confirmer dans Swagger.
// Structure supposée (à ajuster selon le vrai schéma) :
// {
//   idClient: number,
//   lignes: [{ idProduit: number, quantite: number, prixUnitaire: number }],
//   commentaire: string
// }
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

// TODO : adapter cette fonction au vrai schéma JSON de POST /commande/enregistrer
// (déplier l'endpoint dans Swagger UI > "Model" ou "Example Value" du Request Body)
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

// En local : écoute sur un port. Sur Vercel : l'export suffit.
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
}

export default app;
