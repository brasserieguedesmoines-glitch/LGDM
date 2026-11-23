// ===========================================================================
//  Espace livreur (téléphone) — accès par lien privé, sans mot de passe
// ===========================================================================
// Adresse : /livreur.html#<jeton>            → mes tournées
//           /livreur.html#<jeton>/<tournée>  → une tournée
// Le jeton reste dans l'ancre : il n'est ni journalisé par les serveurs ni
// transmis aux sites ouverts depuis la page (Waze, Google Maps…).
//
// Règles de sûreté :
//   • ouvrir Waze n'enregistre rien : seule la confirmation « Tout est livré
//     et conforme ? » valide une livraison ;
//   • une carte ne passe au vert qu'une fois la validation acceptée par le
//     serveur. En cas d'échec, l'envoi est gardé sur le téléphone, signalé
//     en rouge et proposé à nouveau (« Réessayer »), même après fermeture ;
//   • chaque envoi porte un identifiant unique : un renvoi ne peut pas créer
//     une seconde validation, et le serveur refuse toute double validation.
(() => {
  const $ = id => document.getElementById(id);
  const page = $('page');
  const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ico = (n, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const heure = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const jourLocal = (dec = 0) => { const d = new Date(); d.setDate(d.getDate() + dec); return d.toLocaleDateString('sv-SE'); };
  const dateLongue = j => new Date(`${j}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const STATUTS = { a_livrer: 'À livrer', livree: 'Livrée', probleme: 'Problème' };
  const stock = {
    lire(cle, defaut = null) { try { return JSON.parse(localStorage.getItem(cle)) ?? defaut; } catch { return defaut; } },
    ecrire(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); } catch {} },
    retirer(cle) { try { localStorage.removeItem(cle); } catch {} },
  };

  // --- Lien : jeton et tournée --------------------------------------------
  let [jeton, idTournee] = location.hash.slice(1).split('/');
  if (!jeton) {
    // Réouverture sans le lien (icône d'écran d'accueil, onglet restauré) :
    // on reprend le dernier lien ouvert sur ce téléphone.
    const dernier = stock.lire('lgdm-livreur-lien');
    if (dernier?.jeton) { jeton = dernier.jeton; idTournee = dernier.idTournee; history.replaceState(null, '', `#${jeton}${idTournee ? '/' + idTournee : ''}`); }
  }
  const CLE_ATTENTE = 'lgdm-livreur-attente';
  const CLE_NAV = 'lgdm-livreur-nav';
  const cleCache = id => `lgdm-livreur-cache-${id}`;

  let tournee = null, motifs = {}, nomLivreur = '', luLe = null;
  let horsLigne = false;
  const enCours = new Set();          // arrêts dont un envoi est en route
  const echecs = new Map();           // idArret → message d'échec affiché
  let derniereNav = null;

  async function api(chemin, opts = {}) {
    let r;
    try {
      r = await fetch(`/api/livreur/${encodeURIComponent(jeton)}${chemin}`, {
        ...opts, headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch { throw Object.assign(new Error('Pas de réseau'), { reseau: true }); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error ?? `Erreur serveur (${r.status})`), { status: r.status, data: d, reseau: r.status >= 500 });
    return d;
  }

  let minuteur;
  function toast(texte, genre = '') {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = `toast ${genre}`;
    t.setAttribute('role', genre === 'ko' ? 'alert' : 'status');
    t.textContent = texte;
    document.body.appendChild(t);
    clearTimeout(minuteur);
    minuteur = setTimeout(() => t.remove(), genre === 'ko' ? 6000 : 3200);
  }
  const annoncer = t => { $('annonces').textContent = t; };

  // --- Thème -------------------------------------------------------------------
  $('b-theme').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('lgdm-livreur-theme', t); } catch {}
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#0D0D0D' : '#F7F7F8');
  });

  // --- Navigation GPS ------------------------------------------------------------
  const destination = a => a.lat != null && a.lng != null ? `${a.lat.toFixed(6)},${a.lng.toFixed(6)}` : a.adresse;
  // Coordonnées exactes quand la brasserie a fait reconnaître l'adresse ;
  // sinon l'adresse complète, que Waze recherche lui-même.
  const lienWaze = a => a.lat != null && a.lng != null
    ? `https://waze.com/ul?ll=${a.lat.toFixed(6)},${a.lng.toFixed(6)}&navigate=yes&zoom=17`
    : `https://waze.com/ul?q=${encodeURIComponent(a.adresse)}&navigate=yes`;
  const lienGoogle = a => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination(a))}&travelmode=driving`;
  const lienPlans = a => `https://maps.apple.com/?daddr=${encodeURIComponent(destination(a))}&dirflg=d`;
  const telLien = t => {
    const m = String(t ?? '').match(/(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/);
    let d = (m ? m[0] : String(t ?? '')).replace(/[^\d+]/g, '');
    if (d.startsWith('0033')) d = '+33' + d.slice(4);
    return d;
  };

  // --- Envois en attente (gardés sur le téléphone) -----------------------------
  const attente = () => stock.lire(CLE_ATTENTE, {});
  const cleArret = idA => `${idTournee}:${idA}`;
  function memoriserEnvoi(idA, envoi) { const m = attente(); m[cleArret(idA)] = envoi; stock.ecrire(CLE_ATTENTE, m); }
  function oublierEnvoi(idA) { const m = attente(); delete m[cleArret(idA)]; stock.ecrire(CLE_ATTENTE, m); }
  const envoiEnAttente = idA => attente()[cleArret(idA)] ?? null;
  const nouvelleOperation = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, '');

  // =========================================================================
  //  Chargement
  // =========================================================================
  async function demarrer() {
    if (!jeton) {
      page.innerHTML = `<div class="vide">${ico('lien')}<b>Lien incomplet</b><span>Ouvrez le lien de tournée envoyé par la brasserie.</span></div>`;
      return;
    }
    stock.ecrire('lgdm-livreur-lien', { jeton, idTournee: idTournee ?? null });
    if (idTournee) await chargerTournee({ premier: true });
    else await chargerListe();
  }

  async function chargerListe() {
    $('progression').hidden = true; $('suivant').hidden = true; $('b-liste').hidden = true;
    try {
      const d = await api('');
      nomLivreur = d.livreur.nom;
      $('titre').textContent = 'Mes tournées';
      $('sous-titre').textContent = `${nomLivreur} · Le Gué des Moines`;
      const auj = d.aujourdhui ?? jourLocal();
      const groupes = [
        ['Aujourd’hui', d.tournees.filter(t => t.date === auj)],
        ['À venir', d.tournees.filter(t => t.date > auj)],
        ['Récentes', d.tournees.filter(t => t.date < auj).reverse()],
      ].filter(([, l]) => l.length);
      page.innerHTML = groupes.length ? groupes.map(([titre, l]) => `<h2 class="groupe">${titre}</h2>` + l.map(t => `
        <a class="carte-tournee" href="#${jeton}/${t.id}">
          <h2>${echap(t.nom)}</h2>
          <p>${dateLongue(t.date)} · ${t.stats.livrees} livrée${t.stats.livrees > 1 ? 's' : ''} sur ${t.stats.total}${t.stats.problemes ? ` · ${t.stats.problemes} problème${t.stats.problemes > 1 ? 's' : ''}` : ''}</p>
          ${barre(t.stats)}
          <span class="gros ${t.statut === 'terminee' || t.statut === 'cloturee' ? 'waze' : 'valider'}">${t.statut === 'terminee' ? 'Tournée terminée — voir' : t.statut === 'cloturee' ? 'Clôturée — voir' : 'Ouvrir la tournée'}</span>
        </a>`).join('')).join('')
        : `<div class="vide">${ico('camion')}<b>Aucune tournée pour le moment</b><span>La brasserie vous enverra le lien de votre prochaine tournée.</span></div>`;
    } catch (e) {
      page.innerHTML = `<div class="bandeau ko">${ico('alerte')}<div><b>${echap(e.reseau ? 'Pas de réseau.' : e.message)}</b>
        <div><button class="gros waze" onclick="location.reload()">Réessayer</button></div></div></div>`;
    }
  }

  async function chargerTournee({ premier = false, silencieux = false } = {}) {
    const avant = tournee ? JSON.stringify(tournee) : null;
    const etaitHorsLigne = horsLigne;
    try {
      const d = await api(`/tournee/${encodeURIComponent(idTournee)}`);
      tournee = d.tournee; motifs = d.motifs; nomLivreur = d.livreur.nom; luLe = Date.now(); horsLigne = false;
      stock.ecrire(cleCache(idTournee), { tournee, motifs, nomLivreur, luLe });
    } catch (e) {
      if (e.status === 404) {
        stock.retirer(cleCache(idTournee));
        page.innerHTML = `<div class="bandeau ko">${ico('alerte')}<div><b>${echap(e.message)}</b>
          <div style="margin-top:6px">Demandez à la brasserie de vous renvoyer le lien.</div></div></div>
          <a class="gros waze" href="#${jeton}">Voir mes tournées</a>`;
        $('progression').hidden = true; $('suivant').hidden = true;
        return;
      }
      horsLigne = true;
      if (!tournee) {
        // Réouverture sans réseau : dernière version connue sur ce téléphone.
        const c = stock.lire(cleCache(idTournee));
        if (c?.tournee) ({ tournee, motifs, nomLivreur, luLe } = c);
      }
      if (!tournee) {
        page.innerHTML = `<div class="bandeau ko">${ico('alerte')}<div><b>Impossible de charger la tournée.</b>
          <div style="margin-top:6px">${e.reseau ? 'Pas de réseau : vérifiez la connexion.' : echap(e.message)}</div>
          <button class="gros waze" id="b-recharger">Réessayer</button></div></div>`;
        $('b-recharger').addEventListener('click', () => chargerTournee({ premier: true }));
        return;
      }
      if (silencieux) { majBandeaux(); return; }
    }
    $('b-liste').hidden = false; $('b-liste').href = `#${jeton}`;
    // Actualisation sans changement : on ne touche pas à la page.
    const change = !silencieux || JSON.stringify(tournee) !== avant || etaitHorsLigne !== horsLigne;
    if (change && !enCours.size) rendre({ premier });
    if (!horsLigne) renvoyerAttente();
  }

  // =========================================================================
  //  Rendu
  // =========================================================================
  function barre(s) {
    if (!s.total) return '<div class="barre"></div>';
    return `<div class="barre" aria-hidden="true">${s.livrees ? `<i class="l" style="width:${s.livrees / s.total * 100}%"></i>` : ''}${s.problemes ? `<i class="p" style="width:${s.problemes / s.total * 100}%"></i>` : ''}</div>`;
  }

  function recalculer() {
    const a = tournee.arrets;
    const s = { total: a.length, livrees: a.filter(x => x.statut === 'livree').length, problemes: a.filter(x => x.statut === 'probleme').length };
    s.aLivrer = s.total - s.livrees - s.problemes;
    tournee.stats = s;
  }

  function rendreEntete() {
    const s = tournee.stats;
    $('titre').textContent = tournee.nom;
    $('sous-titre').textContent = `${dateLongue(tournee.date)} · ${nomLivreur}`;
    document.title = `${tournee.nom} — Ma tournée`;
    const p = $('progression');
    p.hidden = false;
    p.innerHTML = `<div class="phrase"><span id="phrase-progression"><b>${s.livrees}</b> ${s.livrees > 1 ? 'livraisons effectuées' : 'livraison effectuée'} sur <b>${s.total}</b></span>
      ${s.problemes ? `<span class="pb">${s.problemes} problème${s.problemes > 1 ? 's' : ''}</span>` : ''}</div>${barre(s)}`;
  }

  function bandeaux() {
    const out = [];
    if (tournee.cloturee) out.push(`<div class="bandeau info">${ico('archive')}<span>Tournée clôturée par la brasserie : consultation seule.</span></div>`);
    if (horsLigne) out.push(`<div class="bandeau ko">${ico('alerte')}<span><b>Hors connexion.</b> Affichage de la dernière version reçue${luLe ? ` (${heure(luLe)})` : ''}.
      Les validations ne pourront être enregistrées qu’au retour du réseau.</span></div>`);
    const n = Object.keys(attente()).filter(k => k.startsWith(idTournee + ':')).length;
    if (n) out.push(`<div class="bandeau ko">${ico('alerte')}<div><b>${n} enregistrement${n > 1 ? 's' : ''} non transmis${n > 1 ? '' : ''} à la brasserie.</b>
      <div>${n > 1 ? 'Ces livraisons ne sont pas encore comptées' : 'Cette livraison n’est pas encore comptée'}.</div>
      <button class="gros danger" id="b-tout-renvoyer" style="min-height:48px">Réessayer maintenant</button></div></div>`);
    if (!tournee.cloturee && tournee.stats.total && !tournee.stats.aLivrer) {
      out.push(`<div class="bandeau ok">${ico('check')}<span>Tournée terminée${tournee.stats.problemes ? ` — ${tournee.stats.problemes} problème${tournee.stats.problemes > 1 ? 's' : ''} signalé${tournee.stats.problemes > 1 ? 's' : ''}` : ''}. Merci !</span></div>`);
    }
    return out.join('');
  }
  function majBandeaux() {
    const z = $('bandeaux');
    if (!z) return;
    z.innerHTML = bandeaux();
    $('b-tout-renvoyer')?.addEventListener('click', () => renvoyerAttente({ manuel: true }));
  }

  function carte(a) {
    const attenteEnvoi = envoiEnAttente(a.id);
    const envoi = enCours.has(a.id);
    const echec = echecs.get(a.id) ?? (attenteEnvoi && !envoi ? 'Enregistrement non transmis.' : null);
    const statut = a.statut;
    const actif = !tournee.cloturee && statut !== 'livree';
    const nav = derniereNav?.a === a.id && statut === 'a_livrer';
    const sansAdresse = !a.adresse;
    return `<article class="arret ${statut}${nav ? ' focus' : ''}" id="arret-${a.id}" data-id="${a.id}" aria-label="Arrêt ${a.numero} : ${echap(a.nom)}, ${STATUTS[statut]}">
      <div class="arret-tete">
        <span class="num" aria-hidden="true">${statut === 'livree' ? ico('check') : a.numero}</span>
        <div class="qui"><h2>${echap(a.nom)}</h2><span class="st ${envoi ? 'attente' : statut}">${envoi ? 'Enregistrement…' : STATUTS[statut]}</span></div>
      </div>
      ${nav ? `<div class="retour-nav">${ico('navigation')} Navigation lancée à ${heure(derniereNav.le)}. Validez quand tout est livré et conforme.</div>` : ''}
      <div class="adresse">${ico('carte')}<span>${sansAdresse ? '<i>Adresse non renseignée</i>' : echap(a.adresse)}</span></div>
      ${sansAdresse && actif ? `<div class="alerte-adresse">${ico('alerte')} Adresse manquante : appelez le client ou la brasserie.</div>` : ''}
      ${a.telephone ? `<a class="tel" href="tel:${echap(telLien(a.telephone))}">${ico('telephone')} Appeler ${echap(a.telephone)}</a>` : ''}
      ${a.consignes && statut !== 'livree' ? `<div class="consignes"><b>Consignes</b>${echap(a.consignes)}</div>` : ''}
      ${statut === 'livree' ? `<div class="info-statut ok">${ico('check')} Livrée à ${heure(a.livraison.le)}${a.livraison.par ? ` par ${echap(a.livraison.par)}` : ''}</div>` : ''}
      ${statut === 'probleme' ? `<div class="info-statut ko"><span>${ico('alerte')} Problème signalé à ${heure(a.probleme.le)} : ${echap(a.probleme.motifLibelle)}</span><q>${echap(a.probleme.commentaire)}</q></div>` : ''}
      ${echec ? `<div class="echec" role="alert"><span><b>${echap(echec)}</b> ${attenteEnvoi ? (attenteEnvoi.type === 'valider' ? 'La livraison n’est PAS encore validée auprès de la brasserie.' : 'Le problème n’est PAS encore transmis.') : ''}</span>
        ${attenteEnvoi ? `<button class="gros" data-reessayer>${ico('annuler')} Réessayer</button>` : ''}</div>` : ''}
      ${actif ? `<div class="actions">
        ${sansAdresse ? '' : `<a class="gros waze" href="${echap(lienWaze(a))}" target="_blank" rel="noopener" data-waze>${ico('navigation')} Ouvrir dans Waze</a>`}
        <button class="gros valider" data-valider${envoi || attenteEnvoi ? ' disabled' : ''}>${ico('check')} Valider la livraison</button>
        <div class="secondaires">
          <button class="lien-btn danger" data-probleme${envoi || attenteEnvoi ? ' disabled' : ''}>Signaler un problème</button>
          ${sansAdresse ? '' : '<button class="lien-btn" data-autres aria-expanded="false">Autre GPS</button>'}
        </div>
        <div class="autres-gps" data-panneau-gps hidden>
          <p data-msg-gps>Waze ne s’ouvre pas ou n’est pas installé ? Choisissez une autre application :</p>
          <a href="${echap(lienGoogle(a))}" target="_blank" rel="noopener" data-nav-alt>Google Maps</a>
          <a href="${echap(lienPlans(a))}" target="_blank" rel="noopener" data-nav-alt>Plans (iPhone)</a>
        </div>
      </div>` : ''}
    </article>`;
  }

  function rendre({ premier = false } = {}) {
    recalculer();
    rendreEntete();
    derniereNav = (() => {
      const n = stock.lire(CLE_NAV);
      return n && n.t === idTournee && Date.now() - n.le < 4 * 3600 * 1000 ? n : null;
    })();
    page.innerHTML = `<div id="bandeaux"></div>
      <div id="arrets" style="display:flex;flex-direction:column;gap:12px">
        ${tournee.arrets.length ? tournee.arrets.map(carte).join('') : `<div class="vide">${ico('liste')}<b>Aucun arrêt dans cette tournée.</b></div>`}
      </div>
      <p class="pied-page">Le Gué des Moines · actualisé automatiquement${luLe ? ` · lu à ${heure(luLe)}` : ''}</p>`;
    majBandeaux();
    majSuivant();
    if (premier) {
      // À l'ouverture : on se place sur l'arrêt en cours (retour de Waze) ou
      // sur le premier arrêt restant.
      const cible = (derniereNav && tournee.arrets.find(a => a.id === derniereNav.a && a.statut === 'a_livrer'))
        ?? tournee.arrets.find(a => a.statut !== 'livree' && a.statut !== 'probleme');
      const premierRestant = tournee.arrets.findIndex(a => a.statut === 'a_livrer');
      if (cible && premierRestant > 0) requestAnimationFrame(() => $(`arret-${cible.id}`)?.scrollIntoView({ block: 'start' }));
    }
  }

  // Mise à jour d'une seule carte : le reste de la page ne bouge pas.
  function majCarte(id) {
    const a = tournee.arrets.find(x => x.id === id);
    const el = $(`arret-${id}`);
    if (!a || !el) return;
    el.outerHTML = carte(a);
    recalculer(); rendreEntete(); majBandeaux(); majSuivant();
  }

  function majSuivant() {
    const s = $('suivant');
    const prochain = tournee?.cloturee ? null : tournee?.arrets.find(a => a.statut === 'a_livrer');
    if (!prochain) { s.hidden = true; return; }
    s.hidden = false;
    s.innerHTML = `<button id="b-suivant" aria-label="Aller au prochain arrêt : ${echap(prochain.nom)}">
      <span class="num">${prochain.numero}</span><span class="t"><small>Prochain arrêt</small><span>${echap(prochain.nom)}</span></span>${ico('chevron')}</button>`;
    $('b-suivant').addEventListener('click', () => $(`arret-${prochain.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  // =========================================================================
  //  Actions
  // =========================================================================
  page.addEventListener('click', e => {
    const el = e.target.closest('.arret');
    const a = el && tournee?.arrets.find(x => x.id === el.dataset.id);
    if (!a) return;
    if (e.target.closest('[data-waze]')) return ouvrirWaze(a, el);
    if (e.target.closest('[data-nav-alt]')) { stock.ecrire(CLE_NAV, { t: idTournee, a: a.id, le: Date.now() }); return; }
    if (e.target.closest('[data-autres]')) {
      const b = e.target.closest('[data-autres]'), p = el.querySelector('[data-panneau-gps]');
      p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden));
      return;
    }
    if (e.target.closest('[data-valider]')) return demanderValidation(a);
    if (e.target.closest('[data-probleme]')) return demanderProbleme(a);
    if (e.target.closest('[data-reessayer]')) return renvoyer(a.id, { manuel: true });
  });

  // Waze : rien n'est enregistré côté brasserie. On retient seulement, sur ce
  // téléphone, vers quel arrêt la navigation est partie, pour y revenir.
  function ouvrirWaze(a, el) {
    stock.ecrire(CLE_NAV, { t: idTournee, a: a.id, le: Date.now() });
    const debut = Date.now();
    let quitte = false;
    const surDepart = () => { if (document.hidden) quitte = true; };
    document.addEventListener('visibilitychange', surDepart);
    // Ni l'application ni le site ne se sont ouverts au bout de 2,5 s : on
    // propose les autres GPS plutôt que de laisser le livreur sans rien.
    setTimeout(() => {
      document.removeEventListener('visibilitychange', surDepart);
      if (quitte || document.hidden || Date.now() - debut > 6000) return;
      const p = $(`arret-${a.id}`)?.querySelector('[data-panneau-gps]');
      if (p) { p.hidden = false; p.querySelector('[data-msg-gps]').textContent = 'Waze ne s’est pas ouvert ? Choisissez une autre application :'; }
    }, 2500);
  }

  // --- Validation ------------------------------------------------------------
  function demanderValidation(a) {
    if (enCours.has(a.id) || a.statut === 'livree' || envoiEnAttente(a.id)) return;
    const dlg = $('dlg-valider');
    $('dv-pour').innerHTML = `Arrêt <b>${a.numero}</b> · <b>${echap(a.nom)}</b>`;
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'oui') return;
      const op = { type: 'valider', operation: nouvelleOperation(), le: Date.now() };
      memoriserEnvoi(a.id, op);
      envoyer(a.id, op);
    };
    dlg.showModal();
  }

  // --- Problème -------------------------------------------------------------
  let problemeArret = null;
  function demanderProbleme(a) {
    if (enCours.has(a.id) || a.statut === 'livree' || envoiEnAttente(a.id)) return;
    problemeArret = a;
    $('dp-pour').innerHTML = `Arrêt <b>${a.numero}</b> · <b>${echap(a.nom)}</b>`;
    $('dp-motifs').innerHTML = Object.entries(motifs).map(([k, l], i) => `<label><input type="radio" name="motif" value="${k}"${i === 0 ? ' checked' : ''}> ${echap(l)}</label>`).join('');
    $('dp-commentaire').value = '';
    $('dp-err').textContent = '';
    $('dlg-probleme').showModal();
  }
  $('dp-annuler').addEventListener('click', () => $('dlg-probleme').close());
  $('f-probleme').addEventListener('submit', e => {
    e.preventDefault();
    const motif = document.querySelector('[name="motif"]:checked')?.value;
    const commentaire = $('dp-commentaire').value.trim();
    if (!motif) { $('dp-err').textContent = 'Choisissez le motif.'; return; }
    if (commentaire.length < 3) { $('dp-err').textContent = 'Le commentaire est obligatoire : précisez ce qui s’est passé.'; $('dp-commentaire').focus(); return; }
    $('dlg-probleme').close();
    const a = problemeArret;
    const op = { type: 'probleme', operation: nouvelleOperation(), motif, commentaire, le: Date.now() };
    memoriserEnvoi(a.id, op);
    envoyer(a.id, op);
  });

  // --- Envoi au serveur -------------------------------------------------------
  async function envoyer(idA, op, { manuel = false } = {}) {
    if (enCours.has(idA)) return;
    enCours.add(idA); echecs.delete(idA);
    majCarte(idA);
    const chemin = `/tournee/${encodeURIComponent(idTournee)}/arret/${encodeURIComponent(idA)}/${op.type === 'valider' ? 'valider' : 'probleme'}`;
    try {
      const d = await api(chemin, { method: 'POST', body: { operation: op.operation, motif: op.motif, commentaire: op.commentaire } });
      oublierEnvoi(idA);
      appliquer(d.arret);
      enCours.delete(idA);
      horsLigne = false;
      majCarte(idA);
      stock.ecrire(cleCache(idTournee), { tournee, motifs, nomLivreur, luLe: Date.now() });
      if (op.type === 'valider') {
        const s = tournee.stats;
        navigator.vibrate?.(40);
        toast(`Livraison validée · ${s.livrees} sur ${s.total}`, 'ok');
        annoncer(`Livraison validée. ${s.livrees} livraisons effectuées sur ${s.total}.`);
        if (derniereNav?.a === idA) stock.retirer(CLE_NAV);
        setTimeout(allerAuSuivant, 700);
      } else {
        toast('Problème transmis à la brasserie');
      }
    } catch (e) {
      enCours.delete(idA);
      if (e.reseau) {
        // Rien n'est perdu : l'envoi reste mémorisé et sera proposé à nouveau.
        echecs.set(idA, e.status ? `Enregistrement refusé par le serveur (${e.status}).` : 'Pas de réseau : enregistrement non transmis.');
        horsLigne = !e.status;
        toast(op.type === 'valider' ? 'Validation NON enregistrée — réessayez' : 'Problème NON transmis — réessayez', 'ko');
        navigator.vibrate?.([80, 60, 80]);
      } else {
        // Refus définitif (déjà validée, tournée clôturée, arrêt retiré…) :
        // l'état du serveur fait foi.
        oublierEnvoi(idA);
        if (e.data?.arret) appliquer(e.data.arret);
        echecs.set(idA, e.message);
        toast(e.message, e.data?.dejaValidee ? 'ok' : 'ko');
        if (!e.data?.arret) chargerTournee({ silencieux: true });
      }
      majCarte(idA);
    }
  }

  function renvoyer(idA, opts) {
    const op = envoiEnAttente(idA);
    if (op) envoyer(idA, op, opts);
  }
  function renvoyerAttente() {
    for (const k of Object.keys(attente())) {
      const [t, idA] = k.split(':');
      if (t === idTournee && tournee?.arrets.some(a => a.id === idA)) renvoyer(idA);
    }
  }

  function appliquer(arret) {
    if (!arret) return;
    const i = tournee.arrets.findIndex(x => x.id === arret.id);
    if (i >= 0) tournee.arrets[i] = { ...tournee.arrets[i], ...arret };
    recalculer();
  }

  function allerAuSuivant() {
    const p = tournee.arrets.find(a => a.statut === 'a_livrer');
    if (p && !document.querySelector('dialog[open]')) $(`arret-${p.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // =========================================================================
  //  Synchronisation
  // =========================================================================
  // Les changements de la brasserie (arrêt ajouté, réordonné, correction)
  // arrivent ici ; les cartes inchangées ne sont pas redessinées.
  async function actualiser() {
    if (!idTournee || document.hidden || document.querySelector('dialog[open]') || enCours.size) return;
    await chargerTournee({ silencieux: true });
  }

  window.addEventListener('hashchange', () => {
    [jeton, idTournee] = location.hash.slice(1).split('/');
    tournee = null; echecs.clear();
    page.innerHTML = '<div class="vide"><span class="loader"></span>Chargement…</div>';
    scrollTo(0, 0);
    demarrer();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Retour dans l'application (après Waze, un appel…) : état frais et
    // retour sur l'arrêt vers lequel la navigation était partie.
    if (!idTournee) return chargerListe();
    actualiser().then(() => {
      const n = stock.lire(CLE_NAV);
      if (n && n.t === idTournee && Date.now() - n.le < 4 * 3600 * 1000 && tournee?.arrets.some(a => a.id === n.a && a.statut === 'a_livrer')) {
        rendre();
        $(`arret-${n.a}`)?.scrollIntoView({ block: 'start' });
      }
    });
  });
  window.addEventListener('online', () => { horsLigne = false; if (idTournee) { renvoyerAttente(); actualiser(); } });
  window.addEventListener('offline', () => { horsLigne = true; majBandeaux(); });
  setInterval(actualiser, 20000);

  demarrer();
})();
