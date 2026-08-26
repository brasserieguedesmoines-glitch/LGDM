// Coquille commune : barre latérale, en-tête et bascule de thème.
// Injectée par script plutôt que recopiée dans chaque page, pour garantir que
// les trois écrans partagent exactement la même navigation.

const PAGES = [
  { href: '/',              icone: 'colis',    libelle: 'Prise de commande' },
  { href: '/pilotage.html', icone: 'pilotage', libelle: 'Pilotage' },
  { href: '/relances.html', icone: 'relances', libelle: 'Relances' },
  { href: '/ruptures.html', icone: 'horloge',  libelle: 'Ruptures' },
  { href: '/prospection.html', icone: 'clients', libelle: 'Prospection' },
];

function lienSidebar({ href, icone, libelle }, actif) {
  return `<a class="sidebar-lien" href="${href}"${actif ? ' aria-current="page"' : ''}>
    <svg class="ico" aria-hidden="true"><use href="#i-${icone}"/></svg>${libelle}
  </a>`;
}

function monterCoquille({ titre, actif, actions = '' }) {
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.id = 'sidebar';
  sidebar.innerHTML = `
    <div class="sidebar-marque">
      <img src="logo.png" alt="">
      <span class="nom">Le Gué des Moines<span>Tournées &amp; commandes</span></span>
    </div>
    <nav aria-label="Navigation principale">
      ${PAGES.map(p => lienSidebar(p, p.href === actif)).join('')}
    </nav>
    <div class="sidebar-pied">
      <a class="sidebar-lien" href="/api/commandes-pdf" target="_blank" rel="noopener">
        <svg class="ico" aria-hidden="true"><use href="#i-pdf"/></svg>Export PDF
      </a>
    </div>`;

  const voile = document.createElement('div');
  voile.className = 'voile-sidebar';

  const entete = document.createElement('header');
  entete.className = 'entete';
  entete.innerHTML = `
    <button class="btn-icone btn-menu" id="btn-menu" aria-label="Ouvrir la navigation" aria-expanded="false">
      <svg class="ico" aria-hidden="true"><use href="#i-liste"/></svg>
    </button>
    <h1>${titre}</h1>
    <div class="entete-actions">
      ${actions}
      <button class="btn-icone btn-theme" id="btn-theme" aria-label="Basculer entre thème clair et sombre">
        <svg class="ico i-soleil" aria-hidden="true"><use href="#i-soleil"/></svg>
        <svg class="ico i-lune" aria-hidden="true"><use href="#i-lune"/></svg>
      </button>
    </div>`;

  const zone = document.createElement('div');
  zone.className = 'zone';
  const main = document.querySelector('main');
  zone.append(entete, main);

  const app = document.createElement('div');
  app.className = 'app';
  app.append(sidebar, zone);
  document.body.append(voile, app);

  // Ouverture de la navigation sur petit écran
  const bascule = document.getElementById('btn-menu');
  const ouvrir = (etat) => {
    sidebar.dataset.ouvert = etat ? '1' : '';
    voile.dataset.ouvert = etat ? '1' : '';
    bascule.setAttribute('aria-expanded', String(etat));
  };
  bascule.addEventListener('click', () => ouvrir(sidebar.dataset.ouvert !== '1'));
  voile.addEventListener('click', () => ouvrir(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ouvrir(false); });

  // Bascule de thème, mémorisée
  document.getElementById('btn-theme').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('lgdm-theme', t);
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', t === 'dark' ? '#0E0E11' : '#F7F7F8');
    document.dispatchEvent(new CustomEvent('theme-change', { detail: t }));
  });
}

window.monterCoquille = monterCoquille;
