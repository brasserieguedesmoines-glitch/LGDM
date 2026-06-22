// ============================================================
// LGDM — Formulaire de commande terrain
// Connexion à l'API EasyBeer via le proxy Express (server.js)
// ============================================================

const selectClient = document.getElementById('select-client');
const btnDerniereCommande = document.getElementById('btn-derniere-commande');
const sectionProduits = document.getElementById('section-produits');
const lignesContainer = document.getElementById('lignes-container');
const btnAjouterLigne = document.getElementById('btn-ajouter-ligne');
const sectionRecap = document.getElementById('section-recap');
const totalHtEl = document.getElementById('total-ht');
const sectionNote = document.getElementById('section-note');
const sectionEnvoi = document.getElementById('section-envoi');
const btnEnvoyer = document.getElementById('btn-envoyer');
const msgStatut = document.getElementById('msg-statut');
const modalOverlay = document.getElementById('modal-overlay');
const modalDetail = document.getElementById('modal-detail');
const btnNouvelleCommande = document.getElementById('btn-nouvelle-commande');

// Catalogue des produits/tarifs pour le client sélectionné
// Format : [{ idProduit, libelle, prixUnitaireHT, unite }]
let catalogue = [];

// ---- Chargement initial des clients ----
async function chargerClients() {
  try {
    const clients = await apiFetch('/api/clients');
    selectClient.innerHTML = '<option value="">— Choisir un client —</option>';
    clients.forEach(c => {
      const opt = document.createElement('option');
      // TODO : ajuster les noms de champs selon la vraie réponse API
      // Champs probables : idClient / id, raisonSociale / nom / libelle
      opt.value = c.idClient ?? c.id ?? c.idPartenaire;
      opt.textContent = c.raisonSociale ?? c.nom ?? c.libelle ?? `Client #${opt.value}`;
      selectClient.appendChild(opt);
    });
  } catch (err) {
    selectClient.innerHTML = '<option value="">Erreur de chargement</option>';
    afficherErreur('Impossible de charger les clients : ' + err.message);
  }
}

// ---- Changement de client ----
selectClient.addEventListener('change', async () => {
  const idClient = selectClient.value;
  if (!idClient) {
    masquerSections();
    return;
  }
  await chargerTarifs(idClient);
  btnDerniereCommande.style.display = 'block';
});

btnDerniereCommande.addEventListener('click', async () => {
  const idClient = selectClient.value;
  if (idClient) await preRemplirDerniereCommande(idClient);
});

async function chargerTarifs(idClient) {
  setStatut('Chargement des tarifs…');
  try {
    catalogue = await apiFetch(`/api/tarifs/${idClient}`);
    // TODO : normaliser selon le vrai schéma API
    // Champs probables : idProduit/id, libelle/nom, prixUnitaireHT/prix, unite
    catalogue = catalogue.map(p => ({
      idProduit: p.idProduit ?? p.id ?? p.idArticle,
      libelle: p.libelle ?? p.nom ?? p.designation,
      prixUnitaireHT: p.prixUnitaireHT ?? p.prix ?? p.prixHT ?? 0,
      unite: p.unite ?? p.uniteVente ?? 'u',
    }));
    setStatut('');
    reinitialiserLignes();
    afficherSections();
  } catch (err) {
    setStatut('Erreur chargement tarifs : ' + err.message, true);
    masquerSections();
  }
}

// ---- Gestion des lignes de commande ----
function reinitialiserLignes() {
  lignesContainer.innerHTML = '';
  ajouterLigne();
}

function ajouterLigne() {
  const idx = lignesContainer.children.length;
  const div = document.createElement('div');
  div.className = 'ligne-produit';
  div.dataset.idx = idx;

  const sel = document.createElement('select');
  sel.innerHTML = '<option value="">— Produit —</option>';
  catalogue.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.idProduit;
    opt.textContent = `${p.libelle} (${p.prixUnitaireHT.toFixed(2)} €/${p.unite})`;
    opt.dataset.prix = p.prixUnitaireHT;
    sel.appendChild(opt);
  });

  const inputQte = document.createElement('input');
  inputQte.type = 'number';
  inputQte.min = 1;
  inputQte.value = 1;
  inputQte.placeholder = 'Qté';

  const spanPrix = document.createElement('span');
  spanPrix.className = 'ligne-prix';
  spanPrix.textContent = '—';

  const btnSuppr = document.createElement('button');
  btnSuppr.className = 'btn-suppr';
  btnSuppr.textContent = '×';
  btnSuppr.title = 'Supprimer cette ligne';

  const mettreAJourPrix = () => {
    const opt = sel.options[sel.selectedIndex];
    const prix = parseFloat(opt?.dataset.prix ?? 0);
    const qte = parseInt(inputQte.value) || 0;
    spanPrix.textContent = prix && qte ? `${(prix * qte).toFixed(2)} €` : '—';
    calculerTotal();
  };

  sel.addEventListener('change', mettreAJourPrix);
  inputQte.addEventListener('input', mettreAJourPrix);

  btnSuppr.addEventListener('click', () => {
    if (lignesContainer.children.length > 1) {
      div.remove();
      calculerTotal();
    }
  });

  div.append(sel, inputQte, spanPrix, btnSuppr);
  lignesContainer.appendChild(div);
}

btnAjouterLigne.addEventListener('click', ajouterLigne);

function calculerTotal() {
  let total = 0;
  lignesContainer.querySelectorAll('.ligne-produit').forEach(div => {
    const sel = div.querySelector('select');
    const inputQte = div.querySelector('input');
    const opt = sel.options[sel.selectedIndex];
    const prix = parseFloat(opt?.dataset.prix ?? 0);
    const qte = parseInt(inputQte.value) || 0;
    if (prix && qte) total += prix * qte;
  });
  totalHtEl.textContent = total.toFixed(2).replace('.', ',') + ' €';
}

// ---- Pré-remplissage depuis la dernière commande ----
async function preRemplirDerniereCommande(idClient) {
  setStatut('Chargement de la dernière commande…');
  try {
    const commande = await apiFetch(`/api/derniere-commande/${idClient}`);
    // TODO : ajuster selon le vrai schéma retourné
    // Champs attendus dans chaque ligne : idProduit, quantite
    const lignes = commande.lignesCommande ?? commande.lignes ?? [];
    if (!lignes.length) { setStatut('Aucune commande précédente trouvée.'); return; }

    lignesContainer.innerHTML = '';
    lignes.forEach(l => {
      ajouterLigne();
      const div = lignesContainer.lastElementChild;
      const sel = div.querySelector('select');
      const inputQte = div.querySelector('input');
      const idProduit = l.idProduit ?? l.idArticle;
      const optMatch = [...sel.options].find(o => o.value == idProduit);
      if (optMatch) sel.value = optMatch.value;
      inputQte.value = l.quantite ?? l.qte ?? 1;
      sel.dispatchEvent(new Event('change'));
    });
    setStatut('');
  } catch (err) {
    setStatut('Impossible de charger la dernière commande.', true);
  }
}

// ---- Soumission ----
btnEnvoyer.addEventListener('click', async () => {
  const idClient = selectClient.value;
  if (!idClient) { setStatut('Veuillez choisir un client.', true); return; }

  const lignes = [];
  let valide = true;
  lignesContainer.querySelectorAll('.ligne-produit').forEach(div => {
    const sel = div.querySelector('select');
    const inputQte = div.querySelector('input');
    const opt = sel.options[sel.selectedIndex];
    const idProduit = sel.value;
    const qte = parseInt(inputQte.value) || 0;
    const prix = parseFloat(opt?.dataset.prix ?? 0);
    if (idProduit && qte > 0) {
      lignes.push({ idProduit: parseInt(idProduit), quantite: qte, prixUnitaire: prix });
    } else if (idProduit || qte) {
      valide = false;
    }
  });

  if (!valide || lignes.length === 0) {
    setStatut('Veuillez compléter toutes les lignes ou en supprimer les vides.', true);
    return;
  }

  const commentaire = document.getElementById('note-livraison').value.trim();

  btnEnvoyer.disabled = true;
  btnEnvoyer.innerHTML = '<span class="loader"></span>Envoi en cours…';
  setStatut('');

  try {
    const result = await apiFetch('/api/commande', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idClient: parseInt(idClient), lignes, commentaire }),
    });
    const ref = result.reference ?? result.idCommande ?? result.id ?? '';
    modalDetail.textContent = ref ? `Référence : ${ref}` : 'Commande enregistrée avec succès.';
    modalOverlay.style.display = 'flex';
  } catch (err) {
    setStatut('Erreur lors de l\'envoi : ' + err.message, true);
  } finally {
    btnEnvoyer.disabled = false;
    btnEnvoyer.textContent = 'Envoyer la commande';
  }
});

btnNouvelleCommande.addEventListener('click', () => {
  modalOverlay.style.display = 'none';
  selectClient.value = '';
  masquerSections();
  document.getElementById('note-livraison').value = '';
  setStatut('');
});

// ---- Helpers ----
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function afficherSections() {
  sectionProduits.style.display = 'flex';
  sectionRecap.style.display = 'flex';
  sectionNote.style.display = 'flex';
  sectionEnvoi.style.display = 'flex';
}

function masquerSections() {
  sectionProduits.style.display = 'none';
  sectionRecap.style.display = 'none';
  sectionNote.style.display = 'none';
  sectionEnvoi.style.display = 'none';
  btnDerniereCommande.style.display = 'none';
}

function setStatut(msg, isError = false) {
  msgStatut.textContent = msg;
  msgStatut.className = isError ? 'error' : '';
}

function afficherErreur(msg) {
  setStatut(msg, true);
}

// ---- Init ----
chargerClients();
