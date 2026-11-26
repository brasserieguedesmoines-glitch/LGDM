// Bascule des barres de filtres en menu déroulant sur téléphone.
//
// Sur petit écran, une rangée de puces se replie sur trois ou quatre lignes et
// pousse le contenu utile hors de l'écran. Un <select> natif tient sur une
// ligne, ouvre le sélecteur du système (confortable au pouce) et reste
// accessible au clavier et aux lecteurs d'écran sans travail supplémentaire.
//
// Les boutons d'origine restent dans le DOM : le menu se contente de cliquer
// celui qui correspond. Toute la logique existante continue donc de fonctionner,
// et l'affichage en puces revient tel quel dès 768 px.

const MOBILE = '(max-width: 767px)';

/**
 * @param {string} selecteurConteneur  barre de filtres à doubler
 * @param {string} attribut            attribut portant la valeur (ex. 'data-vue')
 * @param {string} libelle             nom du groupe, annoncé aux lecteurs d'écran
 */
function menuMobile(selecteurConteneur, attribut, libelle) {
  const conteneur = document.querySelector(selecteurConteneur);
  if (!conteneur || conteneur.dataset.menuPret) return;
  const boutons = [...conteneur.querySelectorAll(`button[${attribut}]`)];
  if (boutons.length < 3) return;   // en dessous, les puces tiennent sur une ligne

  const enveloppe = document.createElement('div');
  enveloppe.className = 'menu-mobile select-enveloppe';

  const select = document.createElement('select');
  select.setAttribute('aria-label', libelle);
  select.innerHTML = boutons
    .map(b => `<option value="${b.getAttribute(attribut)}">${b.textContent.trim()}</option>`)
    .join('');

  const actif = boutons.find(b => b.classList.contains('actif'));
  if (actif) select.value = actif.getAttribute(attribut);

  select.addEventListener('change', () => {
    boutons.find(b => b.getAttribute(attribut) === select.value)?.click();
  });

  // Le menu suit l'état réel : un changement déclenché ailleurs (clic sur une
  // carte, filtre appliqué par le code) doit s'y refléter.
  new MutationObserver(() => {
    const courant = boutons.find(b => b.classList.contains('actif'));
    if (courant && select.value !== courant.getAttribute(attribut)) {
      select.value = courant.getAttribute(attribut);
    }
  }).observe(conteneur, { subtree: true, attributes: true, attributeFilter: ['class'] });

  enveloppe.appendChild(select);
  conteneur.parentNode.insertBefore(enveloppe, conteneur);
  conteneur.dataset.menuPret = '1';
  conteneur.classList.add('a-replier');
}

/** Regroupe des commandes secondaires derrière un bouton « Plus » sur mobile. */
function replierActions(selecteurConteneur, selecteurBoutons, libelle = 'Plus d’actions') {
  const conteneur = document.querySelector(selecteurConteneur);
  if (!conteneur || conteneur.dataset.replisPret) return;
  const cibles = [...conteneur.querySelectorAll(selecteurBoutons)];
  if (!cibles.length) return;

  const groupe = document.createElement('div');
  groupe.className = 'actions-repliees';

  const bascule = document.createElement('button');
  bascule.type = 'button';
  bascule.className = 'btn-plus';
  bascule.setAttribute('aria-expanded', 'false');
  bascule.innerHTML = `${window.ico ? ico('liste') : ''} ${libelle}`;

  const panneau = document.createElement('div');
  panneau.className = 'panneau-actions';
  panneau.hidden = true;
  cibles.forEach(c => panneau.appendChild(c));

  bascule.addEventListener('click', () => {
    const ouvert = bascule.getAttribute('aria-expanded') === 'true';
    bascule.setAttribute('aria-expanded', String(!ouvert));
    panneau.hidden = ouvert;
  });
  // Refermer au clic extérieur évite de masquer le contenu sous le panneau
  document.addEventListener('click', e => {
    if (!groupe.contains(e.target) && bascule.getAttribute('aria-expanded') === 'true') {
      bascule.setAttribute('aria-expanded', 'false');
      panneau.hidden = true;
    }
  });

  groupe.append(bascule, panneau);
  conteneur.appendChild(groupe);
  conteneur.dataset.replisPret = '1';
}

/**
 * Bloc d'état commun quand un chargement échoue (ou reste incomplet) : ce qui
 * s'est passé, la cause donnée par le serveur, ce qu'on peut faire, et un
 * bouton « Réessayer ». Modèle : le bandeau de la page Prospection.
 * @param {string} titre      ex. « Liste des clients indisponible »
 * @param {string} cause      message du serveur, affiché tel quel
 * @param {{ reessayer?: Function, niveau?: 'erreur'|'alerte', conseil?: string }} options
 * @returns {HTMLElement}
 */
function blocErreur(titre, cause, { reessayer = null, niveau = 'erreur', conseil = conseilErreur(cause) } = {}) {
  const bloc = document.createElement('div');
  bloc.className = `bloc-erreur${niveau === 'alerte' ? ' alerte' : ''}`;
  bloc.setAttribute('role', niveau === 'alerte' ? 'status' : 'alert');
  bloc.innerHTML = `${window.ico ? ico('alerte') : ''}<div class="texte"><b></b><p class="cause"></p>${conseil ? '<p class="conseil"></p>' : ''}</div>`;
  bloc.querySelector('b').textContent = titre;
  bloc.querySelector('.cause').textContent = cause ?? '';
  if (conseil) bloc.querySelector('.conseil').textContent = conseil;
  if (reessayer) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.textContent = 'Réessayer';
    b.addEventListener('click', () => { b.disabled = true; b.textContent = 'Nouvel essai…'; reessayer(); });
    bloc.appendChild(b);
  }
  return bloc;
}

// Ce qu'il faut faire selon la cause. Pendant un blocage EasyBeer, recharger
// ne sert à rien : le serveur donne l'heure de fin, on le rappelle.
function conseilErreur(cause) {
  const c = String(cause ?? '').toLowerCase();
  if (/satur/.test(c)) return 'EasyBeer limite le nombre d’appels : attendez l’heure indiquée, recharger avant ne sert à rien.';
  if (/délai|injoignable/.test(c)) return 'EasyBeer met trop de temps à répondre : réessayez dans une minute.';
  return null;
}

window.blocErreur = blocErreur;
window.menuMobile = menuMobile;
window.replierActions = replierActions;
window.estMobile = () => window.matchMedia(MOBILE).matches;
