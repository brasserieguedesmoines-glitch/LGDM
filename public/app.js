// ---- Composant SearchSelect ----
// Crée un champ de recherche avec liste déroulante filtrée
// options: [{ value, label }], onChange(value) appelé à la sélection
function createSearchSelect(placeholder, options, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'search-select';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';

  const dropdown = document.createElement('div');
  dropdown.className = 'search-dropdown';
  dropdown.style.display = 'none';

  let selectedValue = '';

  function renderOptions(filter) {
    const q = filter.toLowerCase();
    const filtered = options.filter(o => o.label.toLowerCase().includes(q));
    dropdown.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'search-option search-empty';
      empty.textContent = 'Aucun résultat';
      dropdown.appendChild(empty);
    } else {
      filtered.forEach(o => {
        const item = document.createElement('div');
        item.className = 'search-option';
        item.textContent = o.label;
        if (o.value === selectedValue) item.classList.add('selected');
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          selectedValue = o.value;
          input.value = o.label;
          dropdown.style.display = 'none';
          onChange(o.value);
        });
        dropdown.appendChild(item);
      });
    }
    dropdown.style.display = 'block';
  }

  input.addEventListener('focus', () => renderOptions(input.value));
  input.addEventListener('input', () => {
    selectedValue = '';
    onChange('');
    renderOptions(input.value);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });

  wrapper.append(input, dropdown);
  wrapper.getValue = () => selectedValue;
  wrapper.setValue = (value, label) => {
    selectedValue = value;
    input.value = label ?? '';
  };
  wrapper.reset = () => {
    selectedValue = '';
    input.value = '';
    dropdown.style.display = 'none';
  };

  return wrapper;
}

// ---- État global ----
let catalogue = [];
let clientSearchSelect = null;
let currentIdClient = '';

const btnDerniereCommande = document.getElementById('btn-derniere-commande');
const sectionClient = document.getElementById('section-client');
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

// ---- Chargement initial des clients ----
async function chargerClients() {
  try {
    const clients = await apiFetch('/api/clients');
    const options = clients.map(c => ({ value: String(c.id), label: c.nom }));

    clientSearchSelect = createSearchSelect('Rechercher un client…', options, async (value) => {
      currentIdClient = value;
      if (!value) { masquerSections(); btnDerniereCommande.style.display = 'none'; return; }
      await chargerTarifs(value);
      btnDerniereCommande.style.display = 'block';
    });

    sectionClient.insertBefore(clientSearchSelect, btnDerniereCommande);
  } catch (err) {
    setStatut('Impossible de charger les clients : ' + err.message, true);
  }
}

btnDerniereCommande.addEventListener('click', async () => {
  if (currentIdClient) await preRemplirDerniereCommande(currentIdClient);
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

function ajouterLigne(valeurInitiale = '', labelInitial = '') {
  const div = document.createElement('div');
  div.className = 'ligne-produit';

  const prodOptions = catalogue.map(p => ({
    value: JSON.stringify({ idProduit: p.idProduit, idContenant: p.idContenant, idLot: p.idLot ?? 1 }),
    label: `${p.libelle} ${p.contenant}`,
  }));

  const prodSelect = createSearchSelect('Rechercher un produit…', prodOptions, () => {});
  if (valeurInitiale) prodSelect.setValue(valeurInitiale, labelInitial);

  const inputQte = document.createElement('input');
  inputQte.type = 'number';
  inputQte.min = 1;
  inputQte.value = 1;
  inputQte.placeholder = 'Qté';

  const btnSuppr = document.createElement('button');
  btnSuppr.className = 'btn-suppr';
  btnSuppr.textContent = '×';
  btnSuppr.title = 'Supprimer';
  btnSuppr.addEventListener('click', () => {
    if (lignesContainer.children.length > 1) div.remove();
  });

  div.append(prodSelect, inputQte, btnSuppr);
  div._prodSelect = prodSelect;
  lignesContainer.appendChild(div);
}

btnAjouterLigne.addEventListener('click', () => ajouterLigne());

// ---- Pré-remplissage depuis la dernière commande ----
async function preRemplirDerniereCommande(idClient) {
  setStatut('Chargement de la dernière commande…');
  try {
    const commande = await apiFetch(`/api/derniere-commande/${idClient}`);
    const lignes = commande.lignesCommande ?? commande.lignes ?? [];
    if (!lignes.length) { setStatut('Aucune commande précédente trouvée.'); return; }

    lignesContainer.innerHTML = '';
    lignes.forEach(l => {
      const idProduit = l.idProduit ?? l.idArticle;
      const idContenant = l.idContenant;
      const idLot = l.idLot ?? 1;
      const prodData = catalogue.find(p => p.idProduit === idProduit && p.idContenant === idContenant);
      const valeur = prodData
        ? JSON.stringify({ idProduit: prodData.idProduit, idContenant: prodData.idContenant, idLot: prodData.idLot ?? 1 })
        : '';
      const label = prodData ? `${prodData.libelle} ${prodData.contenant}` : '';

      ajouterLigne(valeur, label);
      const div = lignesContainer.lastElementChild;
      div.querySelector('input[type="number"]').value = l.quantite ?? l.qte ?? 1;
    });
    setStatut('');
  } catch (err) {
    setStatut('Impossible de charger la dernière commande.', true);
  }
}

// ---- Soumission ----
btnEnvoyer.addEventListener('click', async () => {
  if (!currentIdClient) { setStatut('Veuillez choisir un client.', true); return; }

  const lignes = [];
  let erreur = false;
  [...lignesContainer.children].forEach(div => {
    const val = div._prodSelect?.getValue();
    const qte = parseInt(div.querySelector('input[type="number"]')?.value) || 0;
    if (!val && qte) { erreur = true; return; }
    if (!val) return;
    try {
      const data = JSON.parse(val);
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
      body: JSON.stringify({ idClient: parseInt(currentIdClient), lignes, commentaire }),
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
  clientSearchSelect?.reset();
  currentIdClient = '';
  masquerSections();
  btnDerniereCommande.style.display = 'none';
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
