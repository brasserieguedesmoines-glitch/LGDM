const selectClient = document.getElementById('select-client');
const btnDerniereCommande = document.getElementById('btn-derniere-commande');
const sectionProduits = document.getElementById('section-produits');
const lignesContainer = document.getElementById('lignes-container');
const btnAjouterLigne = document.getElementById('btn-ajouter-ligne');
const sectionNote = document.getElementById('section-note');
const sectionEnvoi = document.getElementById('section-envoi');
const btnEnvoyer = document.getElementById('btn-envoyer');
const msgStatut = document.getElementById('msg-statut');
const modalOverlay = document.getElementById('modal-overlay');
const modalDetail = document.getElementById('modal-detail');
const btnNouvelleCommande = document.getElementById('btn-nouvelle-commande');

// Catalogue des produits pour le client sélectionné
// Format : [{ idProduit, idContenant, idLot, libelle, contenant, prixHT }]
let catalogue = [];

// ---- Chargement initial des clients ----
async function chargerClients() {
  try {
    const clients = await apiFetch('/api/clients');
    selectClient.innerHTML = '<option value="">— Choisir un client —</option>';
    clients.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nom;
      selectClient.appendChild(opt);
    });
  } catch (err) {
    selectClient.innerHTML = '<option value="">Erreur de chargement</option>';
    setStatut('Impossible de charger les clients : ' + err.message, true);
  }
}

// ---- Changement de client ----
selectClient.addEventListener('change', async () => {
  const idClient = selectClient.value;
  if (!idClient) { masquerSections(); return; }
  await chargerTarifs(idClient);
  btnDerniereCommande.style.display = 'block';
});

btnDerniereCommande.addEventListener('click', async () => {
  const idClient = selectClient.value;
  if (idClient) await preRemplirDerniereCommande(idClient);
});

async function chargerTarifs(idClient) {
  setStatut('Chargement des produits…');
  btnDerniereCommande.style.display = 'none';
  masquerSections();
  try {
    catalogue = await apiFetch(`/api/tarifs/${idClient}`);
    setStatut('');
    reinitialiserLignes();
    afficherSections();
  } catch (err) {
    setStatut('Erreur chargement produits : ' + err.message, true);
  }
}

// ---- Gestion des lignes de commande ----
function reinitialiserLignes() {
  lignesContainer.innerHTML = '';
  ajouterLigne();
}

function ajouterLigne() {
  const div = document.createElement('div');
  div.className = 'ligne-produit';

  const sel = document.createElement('select');
  sel.innerHTML = '<option value="">— Produit —</option>';
  catalogue.forEach(p => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ idProduit: p.idProduit, idContenant: p.idContenant, idLot: p.idLot ?? 1, prixHT: p.prixHT });
    opt.textContent = `${p.libelle} ${p.contenant}`;
    sel.appendChild(opt);
  });

  const inputQte = document.createElement('input');
  inputQte.type = 'number';
  inputQte.min = 1;
  inputQte.value = 1;
  inputQte.placeholder = 'Qté';

  const btnSuppr = document.createElement('button');
  btnSuppr.className = 'btn-suppr';
  btnSuppr.textContent = '×';
  btnSuppr.title = 'Supprimer';

  sel.addEventListener('change', () => {});
  btnSuppr.addEventListener('click', () => {
    if (lignesContainer.children.length > 1) div.remove();
  });

  div.append(sel, inputQte, btnSuppr);
  lignesContainer.appendChild(div);
}

btnAjouterLigne.addEventListener('click', ajouterLigne);

// ---- Pré-remplissage depuis la dernière commande ----
async function preRemplirDerniereCommande(idClient) {
  setStatut('Chargement de la dernière commande…');
  try {
    const commande = await apiFetch(`/api/derniere-commande/${idClient}`);
    const lignes = commande.lignesCommande ?? commande.lignes ?? [];
    if (!lignes.length) { setStatut('Aucune commande précédente trouvée.'); return; }

    lignesContainer.innerHTML = '';
    lignes.forEach(l => {
      ajouterLigne();
      const div = lignesContainer.lastElementChild;
      const sel = div.querySelector('select');
      const inputQte = div.querySelector('input');
      const idProduit = l.idProduit ?? l.idArticle;
      const idContenant = l.idContenant;
      const optMatch = [...sel.options].find(o => {
        try { const d = JSON.parse(o.value); return d.idProduit === idProduit && d.idContenant === idContenant; } catch { return false; }
      });
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
  let erreur = false;
  lignesContainer.querySelectorAll('.ligne-produit').forEach(div => {
    const sel = div.querySelector('select');
    const inputQte = div.querySelector('input');
    const qte = parseInt(inputQte.value) || 0;
    if (!sel.value && qte) { erreur = true; return; }
    if (!sel.value) return;
    try {
      const data = JSON.parse(sel.value);
      if (qte > 0) lignes.push({ ...data, quantite: qte });
    } catch { erreur = true; }
  });

  if (erreur || lignes.length === 0) {
    setStatut('Veuillez compléter toutes les lignes ou supprimer les lignes vides.', true);
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
  sectionNote.style.display = 'flex';
  sectionEnvoi.style.display = 'flex';
}

function masquerSections() {
  sectionProduits.style.display = 'none';
  sectionNote.style.display = 'none';
  sectionEnvoi.style.display = 'none';
}

function setStatut(msg, isError = false) {
  msgStatut.textContent = msg;
  msgStatut.className = isError ? 'error' : '';
}

chargerClients();
