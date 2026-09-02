// Jeu d'icônes SVG (tracés géométriques, style Lucide — licence MIT).
// Remplace les emojis : ceux-ci rendent différemment selon l'OS, ne suivent pas
// la couleur du thème et sont lus à voix haute par les lecteurs d'écran.
const TRACES = {
  pilotage:  '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  relances:  '<path d="M3 6h11M3 12h11M3 18h7"/><path d="m17 16 2 2 4-4"/>',
  pdf:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  soleil:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  lune:      '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  camion:    '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.3a2 2 0 0 0-.6-1.4L18 9h-4v8h2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  calendrier:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  carte:     '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  clients:   '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  colis:     '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  bouteille: '<path d="M10 2h4v3.5a4 4 0 0 0 .6 2.1l.8 1.3a4 4 0 0 1 .6 2.1V21a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V11a4 4 0 0 1 .6-2.1l.8-1.3A4 4 0 0 0 10 5.5z"/><path d="M8 14h8"/>',
  fut:       '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M5 8h14M5 16h14"/>',
  goutte:    '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  euro:      '<path d="M4 10h12M4 14h9"/><path d="M19 4.7A7.5 7.5 0 0 0 9 12a7.5 7.5 0 0 0 10 7.3"/>',
  horloge:   '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  alerte:    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check:     '<path d="M20 6 9 17l-5-5"/>',
  croix:     '<path d="M18 6 6 18M6 6l12 12"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  recherche: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  imprimer:  '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  photo:     '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.5"/>',
  telecharger:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  retour:    '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chevron:   '<path d="m6 9 6 6 6-6"/>',
  telephone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  mail:      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  magasin:   '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/>',
  restaurant:'<path d="M3 2v7a3 3 0 0 0 6 0V2"/><path d="M6 9v13"/><path d="M17 2v20"/><path d="M17 8c2 0 3-1.5 3-3.5S19 2 17 2"/>',
  brasserie: '<path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v5M13 12v5"/><path d="M5 8h12v9a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M5 8a3 3 0 0 1 3-3h1a3 3 0 0 1 5 0h1a3 3 0 0 1 2 3"/>',
  liste:     '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  stats:     '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
};

// Sprite injecté une seule fois : les icônes sont ensuite référencées par <use>,
// ce qui évite de dupliquer les tracés à chaque occurrence.
function injecterSprite() {
  if (document.getElementById('sprite-icones')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'sprite-icones';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'none';
  svg.innerHTML = Object.entries(TRACES)
    .map(([nom, d]) => `<symbol id="i-${nom}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`)
    .join('');
  document.body.prepend(svg);
}

// Icône décorative : masquée aux lecteurs d'écran, le texte voisin porte le sens.
// Passer un libellé la rend annonçable quand elle est seule porteuse d'information.
function ico(nom, { classe = '', libelle = null } = {}) {
  const a11y = libelle ? `role="img" aria-label="${libelle}"` : 'aria-hidden="true"';
  return `<svg class="ico ${classe}" ${a11y}><use href="#i-${nom}"/></svg>`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injecterSprite);
} else {
  injecterSprite();
}

window.ico = ico;
