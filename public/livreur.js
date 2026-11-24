// ===========================================================================
//  Espace livreur (téléphone) — accès par lien privé, sans mot de passe
// ===========================================================================
// Adresse : /livreur.html#<jeton>            → mes tournées
//           /livreur.html#<jeton>/<tournée>  → une tournée
// Le jeton reste dans l'ancre : il n'est ni journalisé par les serveurs ni
// transmis aux sites ouverts depuis la page (Waze, Google Maps…).
//
// Une carte compacte par arrêt, quatre boutons sur une ligne :
//   Note · Photo · Waze · Valider.
//
// Règles de sûreté :
//   • ouvrir Waze n'enregistre rien : seule la confirmation « Tout est livré
//     et conforme ? » valide une livraison ;
//   • rien ne s'affiche comme enregistré avant l'accord du serveur. Un envoi
//     qui échoue (validation, problème, note, photo) est gardé sur le
//     téléphone, signalé en rouge et proposé à nouveau (« Réessayer »),
//     même après fermeture de la page ;
//   • chaque envoi porte un identifiant unique : un renvoi ne crée ni seconde
//     validation ni photo en double.
(() => {
  const $ = id => document.getElementById(id);
  const page = $('page');
  const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ico = (n, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const heure = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const jourLocal = (dec = 0) => { const d = new Date(); d.setDate(d.getDate() + dec); return d.toLocaleDateString('sv-SE'); };
  const dateLongue = j => new Date(`${j}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const STATUTS = { a_livrer: 'À livrer', livree: 'Livrée', probleme: 'Problème' };
  const MAX_PHOTOS = 3;
  const stock = {
    lire(cle, defaut = null) { try { return JSON.parse(localStorage.getItem(cle)) ?? defaut; } catch { return defaut; } },
    ecrire(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); return true; } catch { return false; } },
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
  const enc = encodeURIComponent;
  const urlPhoto = id => `/api/livreur/${enc(jeton)}/tournee/${enc(idTournee)}/photo/${enc(id)}`;
  const urlRapport = () => `/api/livreur/${enc(jeton)}/tournee/${enc(idTournee)}/rapport.pdf`;

  let tournee = null, motifs = {}, nomLivreur = '', luLe = null;
  let horsLigne = false;
  const enCours = new Set();          // opérations en route
  const echecs = new Map();           // opération → raison de l'échec
  const refus = new Map();            // arrêt → refus définitif du serveur
  const memoire = new Map();          // opérations trop lourdes pour le stockage local
  let derniereNav = null;

  async function api(chemin, { method = 'GET', body } = {}) {
    let r;
    try {
      r = await fetch(`/api/livreur/${enc(jeton)}${chemin}`, {
        method, headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: body ? JSON.stringify(body) : undefined,
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
    : `https://waze.com/ul?q=${enc(a.adresse)}&navigate=yes`;
  const lienGoogle = a => `https://www.google.com/maps/dir/?api=1&destination=${enc(destination(a))}&travelmode=driving`;
  const lienPlans = a => `https://maps.apple.com/?daddr=${enc(destination(a))}&dirflg=d`;
  const telLien = t => {
    const m = String(t ?? '').match(/(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/);
    let d = (m ? m[0] : String(t ?? '')).replace(/[^\d+]/g, '');
    if (d.startsWith('0033')) d = '+33' + d.slice(4);
    return d;
  };
  // « Horaire prévu : 08:37 » (repris à l'import) s'affiche à côté du téléphone.
  function decouperConsignes(c) {
    let horaire = '';
    const reste = String(c ?? '').split('\n').filter(l => {
      const m = l.match(/^\s*Horaire prévu\s*:\s*(.+)$/i);
      if (m && !horaire) { horaire = m[1].trim(); return false; }
      return true;
    }).join('\n').trim();
    return { horaire, reste };
  }

  // --- Envois en attente (gardés sur le téléphone) -----------------------------
  // { [opération]: { t: tournée, a: arrêt, type, …contenu, le } }
  function attente() {
    const m = stock.lire(CLE_ATTENTE, {});
    // Ancien format (une entrée « tournée:arrêt » par arrêt) : converti.
    let migre = false;
    for (const [k, v] of Object.entries(m)) {
      if (v && !v.t && k.includes(':')) {
        const [t, a] = k.split(':');
        delete m[k];
        if (v.operation) m[v.operation] = { ...v, t, a };
        migre = true;
      }
    }
    if (migre) stock.ecrire(CLE_ATTENTE, m);
    for (const [k, v] of memoire) if (!m[k]) m[k] = v;
    return m;
  }
  function memoriser(op) {
    const m = stock.lire(CLE_ATTENTE, {});
    m[op.operation] = op;
    if (!stock.ecrire(CLE_ATTENTE, m)) memoire.set(op.operation, op);
  }
  function oublier(op) {
    const m = stock.lire(CLE_ATTENTE, {});
    delete m[op.operation];
    stock.ecrire(CLE_ATTENTE, m);
    memoire.delete(op.operation);
    echecs.delete(op.operation);
  }
  const opsArret = idA => Object.values(attente()).filter(o => o.t === idTournee && o.a === idA).sort((x, y) => x.le - y.le);
  const opsTournee = () => Object.values(attente()).filter(o => o.t === idTournee);
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
          <span class="gros ${t.statut === 'terminee' || t.statut === 'cloturee' ? 'waze' : 'accent'}">${t.statut === 'terminee' ? 'Tournée terminée — voir' : t.statut === 'cloturee' ? 'Clôturée — voir' : 'Ouvrir la tournée'}</span>
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
      const d = await api(`/tournee/${enc(idTournee)}`);
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
    const n = opsTournee().length;
    if (n) out.push(`<div class="bandeau ko">${ico('alerte')}<div><b>${n} enregistrement${n > 1 ? 's' : ''} non transmis à la brasserie.</b>
      <div>${n > 1 ? 'Ils ne sont pas encore pris en compte' : 'Il n’est pas encore pris en compte'} : réessayez dès que le réseau revient.</div>
      <button class="gros danger" id="b-tout-renvoyer" style="min-height:48px">Réessayer maintenant</button></div></div>`);
    if (tournee.stats.total && !tournee.stats.aLivrer) {
      out.push(`<div class="bandeau ok" style="flex-direction:column;align-items:stretch">
        <span>${ico('check')} Tournée terminée${tournee.stats.problemes ? ` — ${tournee.stats.problemes} problème${tournee.stats.problemes > 1 ? 's' : ''} signalé${tournee.stats.problemes > 1 ? 's' : ''}` : ''}. Merci !</span>
        <a class="gros accent" href="${urlRapport()}" target="_blank" rel="noopener" data-rapport>${ico('pdf')} Rapport PDF de la tournée</a></div>`);
    }
    return out.join('');
  }
  function majBandeaux() {
    const z = $('bandeaux');
    if (!z) return;
    z.innerHTML = bandeaux();
    $('b-tout-renvoyer')?.addEventListener('click', () => renvoyerAttente());
  }

  const LIBELLE_ECHEC = {
    valider: 'Validation NON enregistrée : la livraison n’est PAS encore validée auprès de la brasserie.',
    probleme: 'Problème NON transmis : il n’est PAS encore connu de la brasserie.',
    note: 'Note non envoyée.',
    photo: 'Photo non envoyée.',
  };

  function carte(a) {
    const ops = opsArret(a.id);
    const opValid = ops.find(o => o.type === 'valider' || o.type === 'probleme');
    const opNote = ops.filter(o => o.type === 'note').pop();
    const opsPhotos = ops.filter(o => o.type === 'photo');
    const envoiValid = opValid && enCours.has(opValid.operation);
    const statut = a.statut;
    const ouverte = !tournee.cloturee;
    const actif = ouverte && statut !== 'livree';
    const nav = derniereNav?.a === a.id && statut === 'a_livrer';
    const sansAdresse = !a.adresse;
    const { horaire, reste } = decouperConsignes(a.consignes);
    const noteTexte = opNote ? opNote.texte : a.note?.texte ?? '';
    const nPhotos = (a.photos?.length ?? 0) + opsPhotos.length;
    const enEchec = ops.filter(o => !enCours.has(o.operation));

    const btNote = `<button class="bt${noteTexte ? ' actif' : ''}" data-note aria-label="${noteTexte ? 'Modifier la note' : 'Laisser une note'} — ${echap(a.nom)}">
      ${opNote && enCours.has(opNote.operation) ? '<span class="loader"></span>' : ''}${ico('crayon')}<span>Note</span></button>`;
    const btPhoto = `<button class="bt${nPhotos ? ' actif' : ''}" data-photo${nPhotos >= MAX_PHOTOS ? ' disabled' : ''} aria-label="Prendre une photo — ${echap(a.nom)}">
      ${nPhotos ? `<b class="compte">${nPhotos}</b>` : ''}${ico('photo')}<span>Photo</span></button>`;
    const btWaze = sansAdresse
      ? `<button class="bt waze" disabled aria-disabled="true">${ico('navigation')}<span>Waze</span></button>`
      : `<a class="bt waze" href="${echap(lienWaze(a))}" target="_blank" rel="noopener" data-waze aria-label="Ouvrir dans Waze — ${echap(a.nom)}">${ico('navigation')}<span>Waze</span></a>`;
    const btValider = `<button class="bt valider" data-valider${opValid ? ' disabled' : ''} aria-label="Valider la livraison — ${echap(a.nom)}">${ico('check')}<span>Valider</span></button>`;

    return `<article class="arret ${statut}${nav ? ' focus' : ''}" id="arret-${a.id}" data-id="${a.id}" aria-label="Arrêt ${a.numero} : ${echap(a.nom)}, ${STATUTS[statut]}">
      <div class="arret-tete">
        <span class="num" aria-hidden="true">${statut === 'livree' ? ico('check') : a.numero}</span>
        <div class="qui"><h2>${echap(a.nom)}</h2><span class="st ${envoiValid ? 'attente' : statut}">${envoiValid ? 'Envoi…' : STATUTS[statut]}</span></div>
      </div>
      <div class="infos">
        <span class="adresse">${sansAdresse ? '<i>Adresse non renseignée</i>' : echap(a.adresse)}</span>
        ${a.telephone || horaire ? `<div class="meta">
          ${a.telephone ? `<a class="tel" href="tel:${echap(telLien(a.telephone))}" aria-label="Appeler ${echap(a.telephone)}">${ico('telephone')} ${echap(a.telephone)}</a>` : ''}
          ${horaire ? `<span class="horaire">${ico('horloge')} ${echap(horaire)}</span>` : ''}</div>` : ''}
      </div>
      ${nav ? `<div class="retour-nav">${ico('navigation')} En route depuis ${heure(derniereNav.le)} · validez une fois tout livré</div>` : ''}
      ${sansAdresse && actif ? `<div class="alerte-adresse">${ico('alerte')} Adresse manquante : appelez le client ou la brasserie.</div>` : ''}
      ${reste && statut !== 'livree' ? `<div class="consignes">${echap(reste)}</div>` : ''}
      ${statut === 'livree' ? `<div class="info-statut ok">${ico('check')} Livrée à ${heure(a.livraison.le)}${a.livraison.par ? ` par ${echap(a.livraison.par)}` : ''}</div>` : ''}
      ${statut === 'probleme' ? `<div class="info-statut ko"><span>${ico('alerte')} Problème signalé à ${heure(a.probleme.le)} : ${echap(a.probleme.motifLibelle)}</span><q>${echap(a.probleme.commentaire)}</q></div>` : ''}
      ${noteTexte ? `<div class="note-arret">${ico('crayon')}<span>${echap(noteTexte)}</span></div>` : ''}
      ${nPhotos ? `<div class="vignettes">
        ${(a.photos ?? []).map(p => `<button class="vignette" data-voir="${p.id}" aria-label="Voir la photo de ${heure(p.le)}"><img src="${urlPhoto(p.id)}" alt="" loading="lazy"></button>`).join('')}
        ${opsPhotos.map(o => `<span class="vignette attente">${enCours.has(o.operation) ? '<span class="loader"></span>' : ''}<img src="${o.image}" alt="Photo en attente d’envoi"></span>`).join('')}
      </div>` : ''}
      ${enEchec.length ? `<div class="echec" role="alert"><span>${[...new Set(enEchec.map(o => o.type))].map(t => `<b>${LIBELLE_ECHEC[t]}</b>`).join('<br>')}
        ${echecs.get(enEchec[0].operation) ? `<br>${echap(echecs.get(enEchec[0].operation))}` : ''}</span>
        <button class="gros" data-reessayer>${ico('annuler')} Réessayer</button></div>` : ''}
      ${refus.get(a.id) ? `<div class="echec" role="alert"><b>${echap(refus.get(a.id))}</b></div>` : ''}
      ${ouverte ? (statut === 'livree' ? `<div class="boutons deux">${btNote}${btPhoto}</div>` : `<div class="boutons">${btNote}${btPhoto}${btWaze}${btValider}</div>`) : ''}
      ${actif ? `<div class="secondaires">
          <button class="lien-btn danger" data-probleme${opValid ? ' disabled' : ''}>Signaler un problème</button>
          ${sansAdresse ? '' : '<button class="lien-btn" data-autres aria-expanded="false">Autre GPS</button>'}
        </div>
        <div class="autres-gps" data-panneau-gps hidden>
          <p data-msg-gps>Waze ne s’ouvre pas ou n’est pas installé ? Choisissez une autre application :</p>
          <a href="${echap(lienGoogle(a))}" target="_blank" rel="noopener" data-nav-alt>Google Maps</a>
          <a href="${echap(lienPlans(a))}" target="_blank" rel="noopener" data-nav-alt>Plans (iPhone)</a>
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
      <div id="arrets" style="display:flex;flex-direction:column;gap:10px">
        ${tournee.arrets.length ? tournee.arrets.map(carte).join('') : `<div class="vide">${ico('liste')}<b>Aucun arrêt dans cette tournée.</b></div>`}
      </div>
      <p class="pied-page">Le Gué des Moines · actualisé automatiquement${luLe ? ` · lu à ${heure(luLe)}` : ''}
        · <a href="${urlRapport()}" target="_blank" rel="noopener" style="color:inherit">Rapport PDF</a></p>`;
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
    const a = tournee?.arrets.find(x => x.id === id);
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
    if (e.target.closest('[data-waze]')) return ouvrirWaze(a);
    if (e.target.closest('[data-nav-alt]')) { stock.ecrire(CLE_NAV, { t: idTournee, a: a.id, le: Date.now() }); return; }
    if (e.target.closest('[data-autres]')) {
      const b = e.target.closest('[data-autres]'), p = el.querySelector('[data-panneau-gps]');
      p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden));
      return;
    }
    if (e.target.closest('[data-valider]')) return demanderValidation(a);
    if (e.target.closest('[data-probleme]')) return demanderProbleme(a);
    if (e.target.closest('[data-note]')) return demanderNote(a);
    if (e.target.closest('[data-photo]')) return demanderPhoto(a);
    const v = e.target.closest('[data-voir]');
    if (v) return voirPhoto(a, v.dataset.voir);
    if (e.target.closest('[data-reessayer]')) { refus.delete(a.id); opsArret(a.id).forEach(o => envoyer(o)); }
  });

  // Waze : rien n'est enregistré côté brasserie. On retient seulement, sur ce
  // téléphone, vers quel arrêt la navigation est partie, pour y revenir.
  function ouvrirWaze(a) {
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
  let validationPour = null;
  function demanderValidation(a) {
    if (a.statut === 'livree' || opsArret(a.id).some(o => o.type === 'valider' || o.type === 'probleme')) return;
    validationPour = a;
    const dlg = $('dlg-valider');
    $('dv-pour').innerHTML = `Arrêt <b>${a.numero}</b> · <b>${echap(a.nom)}</b>`;
    $('dv-photo').hidden = (a.photos?.length ?? 0) + opsArret(a.id).filter(o => o.type === 'photo').length > 0;
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'oui') return;
      const op = { type: 'valider', operation: nouvelleOperation(), t: idTournee, a: a.id, le: Date.now() };
      memoriser(op);
      envoyer(op);
    };
    dlg.showModal();
  }
  // Personne pour signer : la photo d'abord (dans le même geste, pour que le
  // téléphone accepte d'ouvrir l'appareil photo), puis on revient valider.
  $('dv-photo').addEventListener('click', () => {
    const a = validationPour;
    $('dlg-valider').close();
    if (a) demanderPhoto(a);
  });

  // --- Problème -------------------------------------------------------------
  let problemeArret = null;
  function demanderProbleme(a) {
    if (a.statut === 'livree' || opsArret(a.id).some(o => o.type === 'valider' || o.type === 'probleme')) return;
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
    const op = { type: 'probleme', operation: nouvelleOperation(), t: idTournee, a: a.id, motif, commentaire, le: Date.now() };
    memoriser(op);
    envoyer(op);
  });

  // --- Note -------------------------------------------------------------------
  let noteArret = null;
  function demanderNote(a) {
    if (tournee.cloturee) return;
    noteArret = a;
    const enAttente = opsArret(a.id).filter(o => o.type === 'note').pop();
    const actuelle = enAttente ? enAttente.texte : a.note?.texte ?? '';
    $('dn-pour').innerHTML = `Arrêt <b>${a.numero}</b> · <b>${echap(a.nom)}</b>`;
    $('dn-texte').value = actuelle;
    $('dn-err').textContent = '';
    $('dn-suppr').hidden = !actuelle;
    $('dlg-note').showModal();
    $('dn-texte').focus();
  }
  function envoyerNote(texte) {
    const a = noteArret;
    $('dlg-note').close();
    if (!a) return;
    // Une seule note en attente par arrêt : la plus récente remplace l'autre.
    opsArret(a.id).filter(o => o.type === 'note' && !enCours.has(o.operation)).forEach(oublier);
    const op = { type: 'note', operation: nouvelleOperation(), t: idTournee, a: a.id, texte, le: Date.now() };
    memoriser(op);
    envoyer(op);
  }
  $('f-note').addEventListener('submit', e => {
    e.preventDefault();
    const texte = $('dn-texte').value.trim();
    const avant = noteArret?.note?.texte ?? '';
    if (!texte && !avant) { $('dlg-note').close(); return; }
    envoyerNote(texte);
  });
  $('dn-suppr').addEventListener('click', () => envoyerNote(''));
  $('dn-annuler').addEventListener('click', () => $('dlg-note').close());

  // --- Photo ------------------------------------------------------------------
  let photoArret = null;
  function demanderPhoto(a) {
    if (tournee.cloturee) return;
    const n = (a.photos?.length ?? 0) + opsArret(a.id).filter(o => o.type === 'photo').length;
    if (n >= MAX_PHOTOS) { toast(`${MAX_PHOTOS} photos au maximum par arrêt.`, 'ko'); return; }
    photoArret = a;
    $('photo-input').value = '';
    $('photo-input').click();
  }
  // Réduite sur le téléphone (1 280 px, JPEG) : rapide à envoyer même en 4G faible.
  async function compresser(f) {
    const url = URL.createObjectURL(f);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.72, d = c.toDataURL('image/jpeg', q);
      while (d.length > 700000 && q > 0.35) { q -= 0.12; d = c.toDataURL('image/jpeg', q); }
      return d;
    } finally { URL.revokeObjectURL(url); }
  }
  $('photo-input').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    const a = photoArret;
    photoArret = null;
    if (!f || !a) return;
    let image;
    try { image = await compresser(f); }
    catch { toast('Photo illisible : reprenez-la.', 'ko'); return; }
    const op = { type: 'photo', operation: nouvelleOperation(), t: idTournee, a: a.id, image, le: Date.now() };
    memoriser(op);
    envoyer(op);
  });

  let photoVue = null;
  function voirPhoto(a, idPhoto) {
    const p = a.photos.find(x => x.id === idPhoto);
    if (!p) return;
    photoVue = { a, p };
    $('dvoir-img').src = urlPhoto(idPhoto);
    $('dvoir-info').textContent = `${a.nom} · photo prise à ${heure(p.le)}${p.par ? ` par ${p.par}` : ''}`;
    $('dvoir-suppr').hidden = !!tournee.cloturee;
    $('dlg-voir').showModal();
  }
  $('dvoir-fermer').addEventListener('click', () => $('dlg-voir').close());
  $('dvoir-suppr').addEventListener('click', async () => {
    if (!photoVue) return;
    const { a, p } = photoVue;
    $('dlg-voir').close();
    try {
      const d = await api(`/tournee/${enc(idTournee)}/arret/${enc(a.id)}/photo/${enc(p.id)}`, { method: 'DELETE' });
      appliquer(d.arret);
      majCarte(a.id);
      toast('Photo supprimée');
    } catch (err) { toast(err.reseau ? 'Pas de réseau : la photo n’a pas été supprimée.' : err.message, 'ko'); }
  });

  // --- Envoi au serveur -------------------------------------------------------
  const CHEMIN = { valider: 'valider', probleme: 'probleme', note: 'note', photo: 'photo' };
  async function envoyer(op) {
    if (enCours.has(op.operation) || op.t !== idTournee) return;
    enCours.add(op.operation); echecs.delete(op.operation); refus.delete(op.a);
    majCarte(op.a);
    try {
      const d = await api(`/tournee/${enc(op.t)}/arret/${enc(op.a)}/${CHEMIN[op.type]}`, {
        method: 'POST',
        body: { operation: op.operation, motif: op.motif, commentaire: op.commentaire, texte: op.texte, image: op.image },
      });
      oublier(op);
      appliquer(d.arret);
      enCours.delete(op.operation);
      horsLigne = false;
      majCarte(op.a);
      stock.ecrire(cleCache(idTournee), { tournee, motifs, nomLivreur, luLe: Date.now() });
      if (op.type === 'valider') {
        const s = tournee.stats;
        navigator.vibrate?.(40);
        toast(`Livraison validée · ${s.livrees} sur ${s.total}`, 'ok');
        annoncer(`Livraison validée. ${s.livrees} livraisons effectuées sur ${s.total}.`);
        if (derniereNav?.a === op.a) stock.retirer(CLE_NAV);
        setTimeout(allerAuSuivant, 700);
      } else {
        toast({ probleme: 'Problème transmis à la brasserie', note: op.texte ? 'Note enregistrée' : 'Note supprimée', photo: 'Photo enregistrée' }[op.type], 'ok');
      }
    } catch (e) {
      enCours.delete(op.operation);
      if (e.reseau) {
        // Rien n'est perdu : l'envoi reste mémorisé et sera proposé à nouveau.
        echecs.set(op.operation, e.status ? `Serveur indisponible (${e.status}).` : 'Pas de réseau.');
        horsLigne = !e.status;
        toast({ valider: 'Validation NON enregistrée — réessayez', probleme: 'Problème NON transmis — réessayez',
          note: 'Note NON envoyée — réessayez', photo: 'Photo NON envoyée — réessayez' }[op.type], 'ko');
        navigator.vibrate?.([80, 60, 80]);
      } else {
        // Refus définitif (déjà validée, tournée clôturée, arrêt retiré…) :
        // l'état du serveur fait foi.
        oublier(op);
        if (e.data?.arret) appliquer(e.data.arret);
        if (!e.data?.dejaValidee) refus.set(op.a, e.message);
        toast(e.message, e.data?.dejaValidee ? 'ok' : 'ko');
        if (!e.data?.arret) chargerTournee({ silencieux: true });
      }
      majCarte(op.a);
    }
  }

  function renvoyerAttente() {
    for (const op of opsTournee()) {
      if (tournee?.arrets.some(a => a.id === op.a)) envoyer(op);
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
    tournee = null; echecs.clear(); refus.clear();
    page.innerHTML = '<div class="vide"><span class="loader"></span>Chargement…</div>';
    scrollTo(0, 0);
    demarrer();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Retour dans l'application (après Waze, un appel, l'appareil photo…) :
    // état frais et retour sur l'arrêt vers lequel la navigation était partie.
    if (!idTournee) return chargerListe();
    actualiser().then(() => {
      const n = stock.lire(CLE_NAV);
      if (n && n.t === idTournee && Date.now() - n.le < 4 * 3600 * 1000 && tournee?.arrets.some(a => a.id === n.a && a.statut === 'a_livrer')
        && !document.querySelector('dialog[open]') && !enCours.size) {
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
