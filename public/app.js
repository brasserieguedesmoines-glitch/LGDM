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
let currentIdClientType = null;
let currentCanal = null;
let toutesGammes = false; // vrai = ignorer le filtre de gamme pour ce client
let adressesLivraison = [];
let selectAdresse = null;

const btnDerniereCommande = document.getElementById('btn-derniere-commande');
const sectionClient = document.getElementById('section-client');
const sectionProduits = document.getElementById('section-produits');
const lignesContainer = document.getElementById('lignes-container');
const btnAjouterLigne = document.getElementById('btn-ajouter-ligne');
const sectionNote = document.getElementById('section-note');
const sectionEnvoi = document.getElementById('section-envoi');
const btnEnvoyer = document.getElementById('btn-envoyer');
const msgStatut = document.getElementById('msg-statut');
const msgStatutClient = document.getElementById('msg-statut-client');
const infoGamme = document.getElementById('info-gamme');
const btnToutesGammes = document.getElementById('btn-toutes-gammes');
const modalOverlay = document.getElementById('modal-overlay');
const modalDetail = document.getElementById('modal-detail');
const btnNouvelleCommande = document.getElementById('btn-nouvelle-commande');

// ---- Chargement initial des clients ----
async function chargerClients() {
  try {
    const clients = await apiFetch('/api/clients');
    const clientTypeIndex = {};
    const clientCanalIndex = {};
    clients.forEach(c => {
      clientTypeIndex[String(c.id)] = c.idClientType;
      clientCanalIndex[String(c.id)] = c.canal;
    });
    const options = clients.map(c => ({ value: String(c.id), label: c.nom }));

    clientSearchSelect = createSearchSelect('Rechercher un client…', options, async (value) => {
      currentIdClient = value;
      currentIdClientType = clientTypeIndex[value] ?? null;
      currentCanal = clientCanalIndex[value] ?? null;
      toutesGammes = false;
      if (!value) { masquerSections(); btnDerniereCommande.style.display = 'none'; return; }
      await chargerTarifs(value);
      btnDerniereCommande.style.display = 'block';
    });

    sectionClient.insertBefore(clientSearchSelect, btnDerniereCommande);

    // Pré-sélection depuis l'URL (?client=ID) — utilisé par la liste de relances
    const preId = new URLSearchParams(location.search).get('client');
    if (preId) {
      const c = clients.find(c => String(c.id) === preId);
      if (c) {
        clientSearchSelect.setValue(String(c.id), c.nom);
        currentIdClient = String(c.id);
        currentIdClientType = c.idClientType ?? null;
        currentCanal = c.canal ?? null;
        await chargerTarifs(currentIdClient);
        btnDerniereCommande.style.display = 'block';
      }
    }
  } catch (err) {
    setStatut('Impossible de charger les clients : ' + err.message, true);
  }
}

btnDerniereCommande.addEventListener('click', async () => {
  if (currentIdClient) await preRemplirDerniereCommande(currentIdClient);
});

// Affiche un sélecteur d'adresse si le client a plusieurs adresses de livraison
async function chargerAdresses(idClient) {
  selectAdresse?.remove();
  selectAdresse = null;
  adressesLivraison = [];
  try {
    const data = await apiFetch(`/api/adresses/${idClient}`);
    adressesLivraison = data.livraison ?? [];
    if (adressesLivraison.length >= 2) {
      selectAdresse = document.createElement('select');
      selectAdresse.id = 'select-adresse';
      adressesLivraison.forEach((a, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = '📍 ' + (a.complete || [a.ligne1, a.ligne2, a.ligne3, a.ligne4].filter(Boolean).join(', '));
        selectAdresse.appendChild(opt);
      });
      sectionClient.appendChild(selectAdresse);
    }
  } catch {}
}

// Gamme attendue selon le canal du client :
// GMS → La Bruguiéroise, tout le reste → gamme classique
function gammeAttendue() {
  return currentCanal === 'GMS' ? 'gms' : 'classique';
}

// Catalogue effectivement proposé dans les listes déroulantes
function catalogueFiltre() {
  if (toutesGammes) return catalogue;
  const attendue = gammeAttendue();
  const filtre = catalogue.filter(p => (p.gamme ?? 'classique') === attendue);
  return filtre.length ? filtre : catalogue; // jamais de liste vide
}

// Bandeau indiquant la gamme active, avec bascule vers le catalogue complet
function majBandeauGamme() {
  const attendue = gammeAttendue();
  const nbGamme = catalogue.filter(p => (p.gamme ?? 'classique') === attendue).length;
  if (!catalogue.length || !nbGamme || nbGamme === catalogue.length) {
    infoGamme.style.display = 'none';
    return;
  }
  infoGamme.style.display = 'flex';
  const nom = attendue === 'gms' ? 'La Bruguiéroise (GMS)' : 'Gamme classique';
  infoGamme.querySelector('.info-gamme-txt').innerHTML = toutesGammes
    ? `Catalogue complet affiché (${catalogue.length} références)`
    : `<strong>${nom}</strong> — ${nbGamme} références proposées`;
  infoGamme.querySelector('button').textContent = toutesGammes
    ? 'Revenir à la gamme du client'
    : 'Afficher toute la gamme';
}

btnToutesGammes.addEventListener('click', () => {
  toutesGammes = !toutesGammes;
  majBandeauGamme();
  reinitialiserLignes();
});

async function chargerTarifs(idClient) {
  msgStatutClient.textContent = 'Chargement des produits…';
  msgStatutClient.className = '';
  btnDerniereCommande.style.display = 'none';
  masquerSections();
  try {
    catalogue = await apiFetch(`/api/tarifs/${idClient}`);
    msgStatutClient.textContent = '';
    majBandeauGamme();
    reinitialiserLignes();
    afficherSections();
    chargerAdresses(idClient); // en arrière-plan, n'est bloquant pour rien
  } catch (err) {
    msgStatutClient.textContent = 'Erreur chargement produits : ' + err.message;
    msgStatutClient.className = 'error';
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

  const prodOptions = catalogueFiltre().map(p => ({
    value: JSON.stringify({ idProduit: p.idProduit, idContenant: p.idContenant, idLot: p.idLot ?? 1, idStockBouteille: p.idStockBouteille, gtin: p.gtin }),
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
    const elements = commande.elementsBouteilles ?? [];
    if (!elements.length) { setStatut('Aucune commande précédente trouvée.'); return; }

    const attendue = gammeAttendue();
    const horsGamme = elements.some(e => {
      const p = catalogue.find(p => p.idProduit === e.stockProduit?.idProduit && p.idContenant === e.stockProduit?.idContenant);
      return p && (p.gamme ?? 'classique') !== attendue;
    });
    if (horsGamme && !toutesGammes) { toutesGammes = true; majBandeauGamme(); }

    lignesContainer.innerHTML = '';
    let introuvables = 0;
    elements.forEach(e => {
      const idProduit = e.stockProduit?.idProduit;
      const idContenant = e.stockProduit?.idContenant;
      const prodData = catalogue.find(p => p.idProduit === idProduit && p.idContenant === idContenant);
      if (!prodData) { introuvables++; return; }
      const valeur = JSON.stringify({ idProduit: prodData.idProduit, idContenant: prodData.idContenant, idLot: prodData.idLot ?? 1, idStockBouteille: prodData.idStockBouteille, gtin: prodData.gtin });
      const label = `${prodData.libelle} ${prodData.contenant}`;

      ajouterLigne(valeur, label);
      const div = lignesContainer.lastElementChild;
      div.querySelector('input[type="number"]').value = e.quantite ?? 1;
    });
    if (!lignesContainer.children.length) ajouterLigne();
    setStatut(introuvables ? `${introuvables} produit(s) de la dernière commande absent(s) du tarif actuel.` : '');
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
      const label = div._prodSelect?.querySelector('input')?.value ?? '';
      if (qte > 0) lignes.push({ ...data, quantite: qte, libelle: label.split(' ').slice(0,-1).join(' '), contenant: label.split(' ').slice(-1)[0] });
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
      body: JSON.stringify({
        idClient: parseInt(currentIdClient),
        idClientType: currentIdClientType,
        nomClient: clientSearchSelect?.querySelector('input')?.value ?? '',
        lignes, commentaire,
        adresseLivraison: selectAdresse ? adressesLivraison[parseInt(selectAdresse.value)] : undefined,
      }),
    });
    const ref = result.map?.numero ?? result.map?.id ?? result.reference ?? result.idCommande ?? result.id ?? '';
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
  currentIdClientType = null;
  currentCanal = null;
  toutesGammes = false;
  infoGamme.style.display = 'none';
  masquerSections();
  btnDerniereCommande.style.display = 'none';
  document.getElementById('note-livraison').value = '';
  selectAdresse?.remove();
  selectAdresse = null;
  adressesLivraison = [];
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
