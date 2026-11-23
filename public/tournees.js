// ===========================================================================
//  Tournées de livraison — espace brasserie
// ===========================================================================
// Une seule page, plusieurs vues pilotées par l'ancre de l'adresse :
//   #encours            tournées en cours et à venir (suivi en direct)
//   #historique         tournées terminées ou clôturées
//   #livreurs           livreurs et leurs liens personnels
//   #nouvelle           création d'une tournée
//   #modifier/<id>      modification
//   #t/<id>             suivi détaillé d'une tournée
//   #import-pilotage    création depuis une tournée calculée par le Pilotage
(() => {
  const $ = id => document.getElementById(id);
  const vue = $('vue');
  const I = window.TourneesImport;
  const API = '/api/tournees-livraison';
  const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const propre = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const pluriel = (n, mot, motP = mot + 's') => `${n} ${n > 1 ? motP : mot}`;

  const STATUT_ARRET = { a_livrer: 'À livrer', livree: 'Livrée', probleme: 'Problème' };
  const STATUT_TOURNEE = { vide: 'À préparer', a_venir: 'À venir', en_cours: 'En cours', terminee: 'Terminée', cloturee: 'Clôturée' };

  const etat = { actives: null, historique: [], histoPage: 0, histoSuite: false, livreurs: [], aujourdhui: jourLocal(),
    detail: null, ed: null, filtre: 'tous', clients: null, lu: null };
  let navigation = 0;          // invalide les réponses arrivées après un changement de vue
  let vueCourante = '';
  let hashPrecedent = location.hash;

  // --- Utilitaires -----------------------------------------------------------
  function jourLocal(decalage = 0) {
    const d = new Date(); d.setDate(d.getDate() + decalage);
    return d.toLocaleDateString('sv-SE');
  }
  const enDate = j => new Date(`${j}T12:00:00`);
  const dateLongue = (j, annee = true) => enDate(j).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(annee ? { year: 'numeric' } : {}) });
  const heure = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const dateHeure = t => new Date(t).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const jourCourt = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  function libelleJour(j) {
    if (j === etat.aujourdhui) return 'Aujourd’hui';
    if (j === jourLocal(1)) return 'Demain';
    if (j === jourLocal(-1)) return 'Hier';
    return enDate(j).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const idLocal = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  async function api(chemin, opts = {}) {
    const o = { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } };
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    let r;
    try { r = await fetch(chemin, o); }
    catch { throw Object.assign(new Error('Pas de connexion au serveur : vérifiez internet puis réessayez.'), { reseau: true }); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error ?? `Erreur ${r.status}`), { status: r.status, data: d });
    return d;
  }

  let minuteurToast;
  function toast(texte, ko = false) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast' + (ko ? ' ko' : '');
    t.setAttribute('role', ko ? 'alert' : 'status');
    t.textContent = texte;
    document.body.appendChild(t);
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(() => t.remove(), ko ? 6000 : 3000);
  }
  const chargement = (texte = 'Chargement…') => `<div class="vide-bloc"><span class="loader"></span>${texte}</div>`;
  const blocErreur = (e, rejouer = 'location.reload()') => `<div class="msg-erreur" role="alert">${ico('alerte')}
    <span>${echap(e.message)}</span><button class="tl-btn mini" onclick="${rejouer}">Réessayer</button></div>`;

  // --- Morceaux d'interface communs ------------------------------------------
  function pastilleTournee(t) {
    const retard = t.date < etat.aujourdhui && ['a_venir', 'en_cours'].includes(t.statut);
    return `<span class="st ${t.statut}">${STATUT_TOURNEE[t.statut] ?? t.statut}</span>${retard ? ' <span class="st retard">En retard</span>' : ''}`;
  }
  const pastilleArret = s => `<span class="st ${s}">${STATUT_ARRET[s] ?? s}</span>`;
  function barreProgression(s) {
    if (!s.total) return '<div class="prog" aria-hidden="true"></div>';
    const pc = n => `${(n / s.total) * 100}%`;
    return `<div class="prog" role="img" aria-label="${s.livrees} livrées, ${s.problemes} problèmes, ${s.aLivrer} à livrer sur ${s.total}">
      ${s.livrees ? `<i class="l" style="width:${pc(s.livrees)}"></i>` : ''}${s.problemes ? `<i class="p" style="width:${pc(s.problemes)}"></i>` : ''}</div>`;
  }
  const compteurs = s => `<div class="compteurs"><span class="c l"><b>${s.livrees}</b> ${s.livrees > 1 ? 'livrées' : 'livrée'}</span>
    <span class="c p"><b>${s.problemes}</b> ${s.problemes > 1 ? 'problèmes' : 'problème'}</span>
    <span class="c"><b>${s.aLivrer}</b> à livrer</span></div>`;

  function barre(actif) {
    const n = etat.actives?.length;
    const onglet = (h, icone, txt, extra = '') => `<a href="#${h}"${actif === h ? ' aria-current="page"' : ''}>${ico(icone)} ${txt}${extra}</a>`;
    return `<div class="tl-barre">
      <nav class="tl-onglets" aria-label="Rubriques des tournées">
        ${onglet('encours', 'camion', 'En cours', n ? ` <span class="nb">${n}</span>` : '')}
        ${onglet('historique', 'archive', 'Historique')}
        ${onglet('livreurs', 'clients', 'Livreurs')}
      </nav>
      <a class="tl-btn principal" href="#nouvelle">${ico('plus')} Nouvelle tournée</a>
    </div>`;
  }

  // --- Partage du lien au livreur --------------------------------------------
  const lienTournee = t => `${location.origin}/livreur.html#${t.livreur.jeton}/${t.id}`;
  const lienEspace = l => `${location.origin}/livreur.html#${l.jeton}`;
  function messagePartage(t, url) {
    const n = t.stats?.total ?? t.arrets?.length ?? 0;
    return `Bonjour ${t.livreur.nom.split(' ')[0]}, voici la tournée « ${t.nom} » du ${dateLongue(t.date, false)} (${pluriel(n, 'livraison')}).\nLien de la tournée : ${url}`;
  }
  function telInternational(tel) {
    let d = I.telEnLien(tel).replace(/^\+/, '');
    if (/^0\d{9}$/.test(d)) d = '33' + d.slice(1);
    return d;
  }
  const lienWhatsApp = (tel, msg) => `https://wa.me/${tel ? telInternational(tel) : ''}?text=${encodeURIComponent(msg)}`;
  const lienSMS = (tel, msg) => `sms:${tel ? I.telEnLien(tel) : ''}?&body=${encodeURIComponent(msg)}`;
  const lienMail = (sujet, msg) => `mailto:?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(msg)}`;

  function panneauPartage(t) {
    if (!t.livreur) {
      return `<h3>${ico('partager')} Envoyer au livreur</h3>
        <p class="carte-soustitre" style="margin-bottom:10px">Choisissez d’abord le livreur de cette tournée : le lien est personnel.</p>
        <a class="tl-btn" href="#modifier/${t.id}">${ico('crayon')} Choisir un livreur</a>`;
    }
    if (!t.livreur.actif) {
      return `<h3>${ico('partager')} Envoyer au livreur</h3>
        <p class="msg-erreur">${echap(t.livreur.nom)} est désactivé : réactivez-le dans l’onglet Livreurs ou choisissez un autre livreur.</p>`;
    }
    const url = lienTournee(t);
    const msg = messagePartage(t, url);
    const sujet = `Tournée « ${t.nom} » du ${dateLongue(t.date, false)}`;
    return `<h3>${ico('partager')} Envoyer la tournée à ${echap(t.livreur.nom)}</h3>
      <div class="partage" data-partage="${t.id}">
        <div class="lien-ligne">
          <input type="text" readonly value="${echap(url)}" aria-label="Lien privé de la tournée" data-lien>
          <button class="tl-btn principal" data-copier>${ico('copier')} Copier le lien</button>
          <button class="tl-btn" data-partager-natif>${ico('partager')} Partager</button>
        </div>
        <div class="directs">Envoyer directement :
          <a class="tl-btn mini" href="${lienWhatsApp(t.livreur.telephone, msg)}" target="_blank" rel="noopener" data-envoi>${ico('message')} WhatsApp</a>
          <a class="tl-btn mini" href="${lienSMS(t.livreur.telephone, msg)}" data-envoi>${ico('telephone')} SMS</a>
          <a class="tl-btn mini" href="${lienMail(sujet, msg)}" data-envoi>${ico('mail')} E-mail</a>
        </div>
        <p class="note" data-note-partage>Lien personnel de ${echap(t.livreur.nom)} : il n’ouvre que ses tournées, sans mot de passe.
          ${t.partageeLe ? `Dernier envoi : ${dateHeure(t.partageeLe)}.` : 'Pas encore envoyé.'}</p>
      </div>`;
  }

  function brancherPartage(racine, t) {
    const zone = racine.querySelector(`[data-partage="${t.id}"]`);
    if (!zone) return;
    const url = lienTournee(t);
    const noter = () => {
      api(`${API}/${t.id}/partage`, { method: 'POST' }).then(d => {
        t.partageeLe = d.partageeLe;
        const n = zone.querySelector('[data-note-partage]');
        if (n) n.textContent = `Lien personnel de ${t.livreur.nom} : il n’ouvre que ses tournées, sans mot de passe. Dernier envoi : ${dateHeure(d.partageeLe)}.`;
      }).catch(() => {});
    };
    zone.querySelector('[data-lien]').addEventListener('focus', e => e.target.select());
    zone.querySelector('[data-copier]').addEventListener('click', async e => {
      const b = e.currentTarget;
      try { await navigator.clipboard.writeText(url); }
      catch { zone.querySelector('[data-lien]').select(); document.execCommand?.('copy'); }
      b.innerHTML = `${ico('check')} Lien copié`;
      setTimeout(() => { b.innerHTML = `${ico('copier')} Copier le lien`; }, 1800);
      noter();
    });
    zone.querySelector('[data-partager-natif]').addEventListener('click', async () => {
      const msg = messagePartage(t, url);
      if (navigator.share) {
        try {
          await navigator.share({ title: `Tournée ${t.nom}`, text: msg.replace(/\nLien de la tournée : .*$/, ''), url });
          noter();
        } catch (e) { if (e.name !== 'AbortError') toast('Partage impossible : copiez le lien.', true); }
      } else {
        toast('Partage direct indisponible sur cet appareil : utilisez WhatsApp, SMS ou E-mail ci-dessous.');
        zone.querySelector('.directs a')?.focus();
      }
    });
    zone.querySelectorAll('[data-envoi]').forEach(a => a.addEventListener('click', noter));
  }

  function partagerDepuisListe(id) {
    const t = etat.actives?.find(x => x.id === id);
    if (!t) return;
    const dlg = $('dlg-petit');
    dlg.innerHTML = `<div class="dlg"><div class="dlg-tete"><div><h2>${echap(t.nom)}</h2><p>${dateLongue(t.date)}</p></div>
      <button class="tl-btn carre discret" data-fermer aria-label="Fermer">${ico('croix')}</button></div>
      <div class="dlg-corps">${panneauPartage(t)}</div></div>`;
    dlg.querySelector('[data-fermer]').addEventListener('click', () => dlg.close());
    brancherPartage(dlg, t);
    dlg.showModal();
  }

  // =========================================================================
  //  Vue « En cours »
  // =========================================================================
  async function afficherActives({ silencieux = false } = {}) {
    const nav = navigation;
    vueCourante = 'encours';
    if (!silencieux) vue.innerHTML = barre('encours') + (etat.actives ? listeActives() : chargement('Chargement des tournées…'));
    try {
      const d = await api(API);
      etat.actives = d.tournees; etat.livreurs = d.livreurs; etat.aujourdhui = d.aujourdhui; etat.lu = Date.now();
      if (nav !== navigation) return;
      vue.innerHTML = barre('encours') + listeActives();
    } catch (e) {
      if (nav !== navigation) return;
      if (silencieux && etat.actives) return;           // on garde l'affichage, on réessaiera
      vue.innerHTML = barre('encours') + blocErreur(e);
    }
    brancherActives();
  }

  function listeActives() {
    const ts = etat.actives ?? [];
    if (!ts.length) {
      return `<div class="vide-bloc">${ico('camion')}<b>Aucune tournée en cours</b>
        <span>Créez une tournée, ajoutez les clients à livrer et envoyez le lien au livreur.</span>
        <a class="tl-btn principal" href="#nouvelle">${ico('plus')} Nouvelle tournée</a></div>`;
    }
    const jour = ts.filter(t => t.date === etat.aujourdhui);
    const s = jour.reduce((a, t) => ({ l: a.l + t.stats.livrees, p: a.p + t.stats.problemes, r: a.r + t.stats.aLivrer, n: a.n + t.stats.total }),
      { l: 0, p: 0, r: 0, n: 0 });
    return `<div class="kpi-ligne" aria-label="Aujourd’hui">
        <div class="kpi"><span class="lbl">Tournées aujourd’hui</span><span class="val">${jour.length}</span></div>
        <div class="kpi"><span class="lbl">Livraisons effectuées</span><span class="val ok">${s.l}<small style="font-size:var(--t-md);color:var(--texte-3)"> / ${s.n}</small></span></div>
        <div class="kpi"><span class="lbl">Problèmes signalés</span><span class="val ${s.p ? 'ko' : ''}">${s.p}</span></div>
        <div class="kpi"><span class="lbl">Restant à livrer</span><span class="val">${s.r}</span></div>
      </div>
      <div class="grille-tournees">${ts.map(carteTournee).join('')}</div>
      <p class="carte-soustitre">Mise à jour automatique toutes les 15 secondes${etat.lu ? ` · dernière lecture à ${new Date(etat.lu).toLocaleTimeString('fr-FR')}` : ''}.</p>`;
  }

  function carteTournee(t) {
    const s = t.stats;
    const lien = t.livreur ? (t.partageeLe ? ` · ${ico('check')} lien envoyé` : ' · lien pas encore envoyé') : '';
    return `<article class="tl-carte ${t.statut} ${s.problemes ? 'avec-probleme' : ''}" data-id="${t.id}">
      <div class="tete"><span class="quand ${t.date === etat.aujourdhui ? 'auj' : ''}">${libelleJour(t.date)}</span><span>${pastilleTournee(t)}</span></div>
      <h3><a href="#t/${t.id}" style="color:inherit;text-decoration:none">${echap(t.nom)}</a></h3>
      <div class="meta">${ico('clients')} ${t.livreur ? echap(t.livreur.nom) : '<span style="color:var(--danger)">Aucun livreur</span>'}
        · ${pluriel(s.total, 'arrêt')}${lien}</div>
      ${barreProgression(s)}
      ${compteurs(s)}
      ${t.derniereActivite ? `<div class="meta">${ico('horloge')} Dernière mise à jour du livreur à ${heure(t.derniereActivite)}</div>` : ''}
      <div class="pied">
        <a class="tl-btn mini" href="#t/${t.id}">${ico('liste')} Suivre</a>
        ${t.statut !== 'cloturee' ? `<a class="tl-btn mini" href="#modifier/${t.id}">${ico('crayon')} Modifier</a>` : ''}
        ${t.livreur ? `<button class="tl-btn mini" data-partager="${t.id}">${ico('partager')} Partager</button>` : ''}
      </div>
    </article>`;
  }

  function brancherActives() {
    vue.querySelectorAll('.tl-carte').forEach(c => c.addEventListener('click', e => {
      if (e.target.closest('a, button')) return;
      location.hash = `#t/${c.dataset.id}`;
    }));
    vue.querySelectorAll('[data-partager]').forEach(b => b.addEventListener('click', () => partagerDepuisListe(b.dataset.partager)));
  }

  // =========================================================================
  //  Vue « Historique »
  // =========================================================================
  async function afficherHistorique(page = 0) {
    const nav = navigation;
    vueCourante = 'historique';
    if (page === 0) { etat.historique = []; vue.innerHTML = barre('historique') + chargement('Chargement de l’historique…'); }
    try {
      const d = await api(`${API}?vue=historique&page=${page}`);
      if (nav !== navigation) return;
      etat.livreurs = d.livreurs;
      etat.historique.push(...d.tournees); etat.histoPage = page; etat.histoSuite = d.suite;
    } catch (e) {
      if (nav !== navigation) return;
      vue.innerHTML = barre('historique') + blocErreur(e);
      return;
    }
    const h = etat.historique;
    vue.innerHTML = barre('historique') + (h.length ? `<div class="table-wrap"><table class="table-histo">
        <thead><tr><th>Date</th><th>Tournée</th><th>Livreur</th><th class="n">Livrées</th><th class="n">Problèmes</th><th>État</th></tr></thead>
        <tbody>${h.map(t => `<tr data-id="${t.id}" tabindex="0">
          <td>${enDate(t.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td><a href="#t/${t.id}" style="color:inherit;font-weight:600;text-decoration:none">${echap(t.nom)}</a></td>
          <td>${t.livreur ? echap(t.livreur.nom) : '—'}</td>
          <td class="n">${t.stats.livrees} / ${t.stats.total}</td>
          <td class="n" style="${t.stats.problemes ? 'color:var(--danger);font-weight:700' : ''}">${t.stats.problemes}</td>
          <td>${pastilleTournee(t)}${t.stats.aLivrer && t.statut === 'cloturee' ? ` <span class="carte-soustitre">${t.stats.aLivrer} non livré${t.stats.aLivrer > 1 ? 's' : ''}</span>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
        ${etat.histoSuite ? '<button class="tl-btn" id="histo-plus" style="align-self:center">Afficher les tournées plus anciennes</button>' : ''}`
      : `<div class="vide-bloc">${ico('archive')}<b>Aucune tournée dans l’historique</b>
          <span>Les tournées terminées les jours précédents et les tournées clôturées apparaissent ici.</span></div>`);
    vue.querySelectorAll('.table-histo tbody tr').forEach(tr => {
      const ouvrir = () => { location.hash = `#t/${tr.dataset.id}`; };
      tr.addEventListener('click', e => { if (!e.target.closest('a')) ouvrir(); });
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
    });
    $('histo-plus')?.addEventListener('click', () => afficherHistorique(etat.histoPage + 1));
  }

  // =========================================================================
  //  Suivi d'une tournée
  // =========================================================================
  async function afficherDetail(id, { silencieux = false } = {}) {
    const nav = navigation;
    vueCourante = 'detail';
    if (!silencieux) { etat.filtre = 'tous'; vue.innerHTML = chargement('Chargement de la tournée…'); }
    try {
      const d = await api(`${API}/${encodeURIComponent(id)}`);
      if (nav !== navigation) return;
      etat.detail = d; etat.lu = Date.now();
    } catch (e) {
      if (nav !== navigation) return;
      if (silencieux && etat.detail) return;
      vue.innerHTML = `<a class="fil" href="#encours">${ico('retour')} Toutes les tournées</a>` + blocErreur(e, `location.hash='#t/${id}';location.reload()`);
      return;
    }
    // Rafraîchissement : ne pas écraser une saisie en cours dans la page.
    if (silencieux && vue.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    rendreDetail();
  }

  function libelleJournal(e) {
    switch (e.type) {
      case 'livree': return `<b>Livraison validée</b> — ${echap(e.nom)}`;
      case 'probleme': return `<b style="color:var(--danger)">Problème signalé</b> — ${echap(e.nom)} : ${echap(({ client_absent: 'Client absent', livraison_partielle: 'Livraison partielle', adresse_incorrecte: 'Adresse incorrecte', refus: 'Livraison refusée', acces_impossible: 'Accès impossible' })[e.motif] ?? 'Autre motif')} — « ${echap(e.commentaire)} »`;
      case 'reinitialise': return `<b>Remis « à livrer »</b> par la brasserie — ${echap(e.nom)}`;
      case 'cloturee': return '<b>Tournée clôturée</b> par la brasserie';
      case 'rouverte': return '<b>Tournée rouverte</b> par la brasserie';
      default: return echap(e.type);
    }
  }

  function rendreDetail() {
    const t = etat.detail, s = t.stats;
    const arrets = t.arrets.filter(a => etat.filtre === 'tous' || a.statut === etat.filtre);
    const retour = t.statut === 'cloturee' || (t.statut === 'terminee' && t.date < etat.aujourdhui) ? 'historique' : 'encours';
    vue.innerHTML = `
      <a class="fil" href="#${retour}">${ico('retour')} ${retour === 'historique' ? 'Historique' : 'Tournées en cours'}</a>
      <div class="entete-tournee">
        <div>
          <h2>${echap(t.nom)}</h2>
          <div class="meta">${ico('calendrier')} ${dateLongue(t.date)} <span>·</span> ${ico('clients')} ${t.livreur ? echap(t.livreur.nom) : 'Aucun livreur'}
            <span>·</span> ${pastilleTournee(t)}</div>
        </div>
        <div class="actions">
          ${!t.clotureeLe ? `<a class="tl-btn" href="#modifier/${t.id}">${ico('crayon')} Modifier</a>` : ''}
          <button class="tl-btn" data-action="dupliquer">${ico('copier')} Dupliquer</button>
          ${t.clotureeLe ? `<button class="tl-btn" data-action="rouvrir">${ico('annuler')} Rouvrir</button>`
            : `<button class="tl-btn" data-action="cloturer">${ico('archive')} Clôturer</button>`}
          ${!s.livrees && !s.problemes ? `<button class="tl-btn danger" data-action="supprimer">${ico('corbeille')} Supprimer</button>` : ''}
        </div>
      </div>
      ${t.clotureeLe ? `<div class="msg-ok" style="background:var(--surface-2);color:var(--texte-2)">Tournée clôturée le ${dateHeure(t.clotureeLe)} :
        le livreur la voit toujours, en lecture seule.</div>` : ''}
      <div class="bloc avancement">
        <div class="phrase"><b>${s.livrees}</b> ${s.livrees > 1 ? 'livraisons effectuées' : 'livraison effectuée'} sur <b>${s.total}</b></div>
        ${barreProgression(s)}${compteurs(s)}
        <div class="carte-soustitre">${t.derniereActivite ? `Dernière mise à jour du livreur à ${heure(t.derniereActivite)} · ` : ''}actualisé automatiquement
          (lu à ${new Date(etat.lu).toLocaleTimeString('fr-FR')}).</div>
      </div>
      ${!t.clotureeLe ? `<div class="bloc">${panneauPartage(t)}</div>` : ''}
      <div class="bloc">
        <h3>${ico('liste')} Arrêts de la tournée</h3>
        <div class="filtres-statut" role="group" aria-label="Filtrer par statut">
          ${[['tous', `Tous (${s.total})`], ['a_livrer', `À livrer (${s.aLivrer})`], ['livree', `Livrée (${s.livrees})`], ['probleme', `Problème (${s.problemes})`]]
            .map(([v, l]) => `<button data-filtre="${v}" aria-pressed="${etat.filtre === v}">${l}</button>`).join('')}
        </div>
        ${arrets.length ? `<table class="arrets-suivi">
          <thead><tr><th>N°</th><th>Client et adresse</th><th>Téléphone</th><th>Consignes</th><th>Statut</th><th>Validation / commentaire</th><th></th></tr></thead>
          <tbody>${arrets.map(a => ligneSuivi(a, t)).join('')}</tbody></table>`
          : `<p class="carte-soustitre">${t.arrets.length ? 'Aucun arrêt avec ce statut.' : 'Aucun arrêt dans cette tournée.'}</p>`}
      </div>
      <div class="bloc">
        <h3>${ico('horloge')} Journal de la tournée</h3>
        ${t.journal.length ? `<ul class="journal">${t.journal.slice().reverse().map(e => `<li><span class="h">${jourCourt(e.le)} ${heure(e.le)}</span>
          <span>${libelleJournal(e)} <span class="q">· ${echap(e.par)}</span></span></li>`).join('')}</ul>`
          : '<p class="carte-soustitre">Aucun événement pour l’instant : les validations et les problèmes signalés par le livreur s’afficheront ici.</p>'}
      </div>`;

    brancherPartage(vue, t);
    vue.querySelectorAll('[data-filtre]').forEach(b => b.addEventListener('click', () => { etat.filtre = b.dataset.filtre; rendreDetail(); }));
    vue.querySelectorAll('[data-reinit]').forEach(b => b.addEventListener('click', () => reinitialiser(t, b.dataset.reinit)));
    vue.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => actionTournee(t, b.dataset.action, b)));
  }

  function ligneSuivi(a, t) {
    const verif = a.verif && a.verif.niveau !== 'ok' ? `<div class="verif ${a.verif.niveau}" style="margin-top:3px">${ico('alerte')} ${echap(a.verif.message)}</div>` : '';
    const pbAvant = a.statut === 'livree' && a.probleme;
    return `<tr class="${a.statut}" data-arret="${a.id}">
      <td class="num">${a.numero}</td>
      <td><div class="cli">${echap(a.nom)}</div>
        <div class="adr">${a.adresse ? echap(a.adresse) : '<span style="color:var(--danger)">Adresse manquante</span>'}</div>${verif}</td>
      <td>${a.telephone ? `<a class="tel" href="tel:${echap(I.telEnLien(a.telephone))}">${echap(a.telephone)}</a>` : '<span class="carte-soustitre">—</span>'}</td>
      <td><div class="consigne">${a.consignes ? echap(a.consignes) : '<span class="carte-soustitre">—</span>'}</div></td>
      <td>${pastilleArret(a.statut)}</td>
      <td class="quand">
        ${a.livraison ? `<b>${heure(a.livraison.le)}</b> · ${jourCourt(a.livraison.le)}<br>par ${echap(a.livraison.par)}` : ''}
        ${a.probleme ? `${pbAvant ? '<div style="margin-top:4px">Problème signalé auparavant :</div>' : `<b>${heure(a.probleme.le)}</b> · ${jourCourt(a.probleme.le)} · ${echap(a.probleme.par)}`}
          <div class="commentaire"${pbAvant ? ' style="opacity:.75"' : ''}><b>${echap(a.probleme.motifLibelle)}</b>${pbAvant ? ` (${heure(a.probleme.le)})` : ''} — ${echap(a.probleme.commentaire)}</div>` : ''}
        ${!a.livraison && !a.probleme ? '<span class="carte-soustitre">—</span>' : ''}
      </td>
      <td>${a.statut !== 'a_livrer' && !t.clotureeLe ? `<button class="tl-btn mini discret" data-reinit="${a.id}" title="Correction : remettre cet arrêt « à livrer »">${ico('annuler')} Remettre à livrer</button>` : ''}</td>
    </tr>`;
  }

  async function reinitialiser(t, idArret) {
    const a = t.arrets.find(x => x.id === idArret);
    if (!confirm(`Remettre « ${a?.nom} » à livrer ?\n\nLa validation ou le problème enregistré sera effacé (il reste visible dans le journal) et le livreur pourra de nouveau valider cet arrêt.`)) return;
    try {
      etat.detail = await api(`${API}/${t.id}/arrets/${idArret}/reinitialiser`, { method: 'POST' });
      rendreDetail();
      toast('Arrêt remis « à livrer »');
    } catch (e) { toast(e.message, true); }
  }

  async function actionTournee(t, action, bouton) {
    try {
      if (action === 'cloturer') {
        const reste = t.stats.aLivrer ? `\n\n${pluriel(t.stats.aLivrer, 'arrêt n’a', 'arrêts n’ont')} pas été livré${t.stats.aLivrer > 1 ? 's' : ''} : ${t.stats.aLivrer > 1 ? 'ils resteront' : 'il restera'} « à livrer » dans l’historique.` : '';
        if (!confirm(`Clôturer la tournée « ${t.nom} » ?\n\nElle passe dans l’historique et le livreur ne peut plus rien y valider.${reste}`)) return;
        bouton.disabled = true;
        etat.detail = await api(`${API}/${t.id}/cloturer`, { method: 'POST' });
        toast('Tournée clôturée');
        rendreDetail();
      } else if (action === 'rouvrir') {
        bouton.disabled = true;
        etat.detail = await api(`${API}/${t.id}/rouvrir`, { method: 'POST' });
        toast('Tournée rouverte');
        rendreDetail();
      } else if (action === 'supprimer') {
        if (!confirm(`Supprimer définitivement la tournée « ${t.nom} » ?`)) return;
        bouton.disabled = true;
        await api(`${API}/${t.id}`, { method: 'DELETE' });
        toast('Tournée supprimée');
        etat.actives = null;
        location.hash = '#encours';
      } else if (action === 'dupliquer') {
        demanderDate(t);
      }
    } catch (e) { bouton.disabled = false; toast(e.message, true); }
  }

  function demanderDate(t) {
    const dlg = $('dlg-petit');
    const demain = jourLocal(1);
    dlg.innerHTML = `<form class="dlg" method="dialog"><div class="dlg-tete"><div><h2>Dupliquer la tournée</h2>
        <p>Mêmes arrêts et même livreur, sans aucun statut de livraison.</p></div></div>
      <div class="dlg-corps">
        <div><label for="dup-nom">Nom</label><input type="text" id="dup-nom" value="${echap(t.nom)}" required></div>
        <div><label for="dup-date">Date de la nouvelle tournée</label><input type="date" id="dup-date" value="${demain}" required></div>
        <p class="msg-erreur" id="dup-err" hidden></p>
      </div>
      <div class="dlg-pied"><span class="info"></span><button class="tl-btn" value="annuler" formnovalidate>Annuler</button>
        <button class="tl-btn principal" id="dup-ok" value="ok">Dupliquer</button></div></form>`;
    dlg.querySelector('#dup-ok').addEventListener('click', async e => {
      e.preventDefault();
      const b = e.currentTarget; b.disabled = true;
      try {
        const n = await api(`${API}/${t.id}/dupliquer`, { method: 'POST', body: { nom: $('dup-nom').value, date: $('dup-date').value } });
        dlg.close(); etat.actives = null;
        toast('Tournée dupliquée');
        location.hash = `#modifier/${n.id}`;
      } catch (err) { b.disabled = false; $('dup-err').hidden = false; $('dup-err').textContent = err.message; }
    });
    dlg.showModal();
  }

  // =========================================================================
  //  Livreurs
  // =========================================================================
  async function chargerLivreurs() {
    etat.livreurs = await api(`${API}/livreurs`);
    return etat.livreurs;
  }

  async function afficherLivreurs() {
    const nav = navigation;
    vueCourante = 'livreurs';
    vue.innerHTML = barre('livreurs') + chargement('Chargement des livreurs…');
    try { await chargerLivreurs(); } catch (e) { if (nav === navigation) vue.innerHTML = barre('livreurs') + blocErreur(e); return; }
    if (nav !== navigation) return;
    rendreLivreurs();
  }

  function rendreLivreurs() {
    const ls = etat.livreurs;
    vue.innerHTML = barre('livreurs') + `
      <div class="bloc">
        <h3>${ico('plus')} Ajouter un livreur</h3>
        <form class="form-ligne" id="f-livreur">
          <div><label for="lv-nom">Nom</label><input type="text" id="lv-nom" required maxlength="80" placeholder="Prénom Nom"></div>
          <div><label for="lv-tel">Téléphone (pour l’envoi par WhatsApp ou SMS)</label><input type="tel" id="lv-tel" maxlength="40" placeholder="06 12 34 56 78"></div>
          <button class="tl-btn principal" type="submit">Ajouter</button>
        </form>
      </div>
      <div class="livreurs-liste">
        ${ls.length ? ls.map(l => `<div class="livreur ${l.actif ? '' : 'inactif'}" data-id="${l.id}">
          <div class="qui"><b>${echap(l.nom)} ${l.actif ? '' : '<span class="st cloturee">Désactivé</span>'}</b>
            <span>${l.telephone ? echap(l.telephone) : 'Pas de téléphone'}</span></div>
          ${l.actif ? `<button class="tl-btn mini" data-l="copier">${ico('lien')} Copier son espace livreur</button>` : ''}
          <button class="tl-btn mini" data-l="modifier">${ico('crayon')} Modifier</button>
          ${l.actif ? `<button class="tl-btn mini" data-l="regenerer" title="L’ancien lien cesse aussitôt de fonctionner">${ico('annuler')} Nouveau lien</button>` : ''}
          <button class="tl-btn mini ${l.actif ? 'danger' : ''}" data-l="${l.actif ? 'desactiver' : 'reactiver'}">${l.actif ? 'Désactiver' : 'Réactiver'}</button>
        </div>`).join('') : `<div class="vide-bloc">${ico('clients')}<b>Aucun livreur</b><span>Ajoutez vos livreurs : chacun reçoit un lien personnel vers ses tournées.</span></div>`}
      </div>
      <p class="carte-soustitre">L’espace livreur liste toutes les tournées attribuées à ce livreur, sans mot de passe : le lien fait office de clé.
        En cas de téléphone perdu ou de départ, créez un nouveau lien ou désactivez le livreur : l’ancien lien ne fonctionne plus.</p>`;

    $('f-livreur').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api(`${API}/livreurs`, { method: 'POST', body: { nom: $('lv-nom').value, telephone: $('lv-tel').value } });
        await chargerLivreurs(); rendreLivreurs(); toast('Livreur ajouté');
      } catch (err) { toast(err.message, true); }
    });
    vue.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', async () => {
      const l = ls.find(x => x.id === b.closest('.livreur').dataset.id);
      try {
        if (b.dataset.l === 'copier') {
          await navigator.clipboard.writeText(lienEspace(l)).catch(() => prompt('Copiez le lien :', lienEspace(l)));
          toast(`Lien de l’espace de ${l.nom} copié`);
          return;
        }
        if (b.dataset.l === 'modifier') {
          const nom = prompt('Nom du livreur :', l.nom); if (nom === null) return;
          const tel = prompt('Téléphone :', l.telephone ?? ''); if (tel === null) return;
          await api(`${API}/livreurs/${l.id}`, { method: 'PUT', body: { nom, telephone: tel } });
        } else if (b.dataset.l === 'regenerer') {
          if (!confirm(`Créer un nouveau lien pour ${l.nom} ?\n\nL’ancien lien (et tous les liens de tournée déjà envoyés) cessera immédiatement de fonctionner : il faudra lui renvoyer ses tournées.`)) return;
          const n = await api(`${API}/livreurs/${l.id}/regenerer`, { method: 'POST' });
          await navigator.clipboard.writeText(lienEspace(n)).catch(() => {});
          toast('Nouveau lien créé et copié');
        } else {
          if (b.dataset.l === 'desactiver' && !confirm(`Désactiver ${l.nom} ? Ses liens cesseront de fonctionner.`)) return;
          await api(`${API}/livreurs/${l.id}`, { method: 'PUT', body: { actif: b.dataset.l === 'reactiver' } });
        }
        await chargerLivreurs(); rendreLivreurs();
      } catch (err) { toast(err.message, true); }
    }));
  }

  function creerLivreurRapide(surCree) {
    const dlg = $('dlg-petit');
    dlg.innerHTML = `<form class="dlg" id="f-lv-rapide"><div class="dlg-tete"><div><h2>Nouveau livreur</h2>
        <p>Il recevra un lien personnel vers ses tournées.</p></div></div>
      <div class="dlg-corps">
        <div><label for="lvr-nom">Nom</label><input type="text" id="lvr-nom" required maxlength="80" placeholder="Prénom Nom"></div>
        <div><label for="lvr-tel">Téléphone (facultatif, pour WhatsApp et SMS)</label><input type="tel" id="lvr-tel" maxlength="40"></div>
        <p class="msg-erreur" id="lvr-err" hidden></p>
      </div>
      <div class="dlg-pied"><span class="info"></span><button type="button" class="tl-btn" data-fermer>Annuler</button>
        <button class="tl-btn principal" type="submit">Ajouter le livreur</button></div></form>`;
    dlg.querySelector('[data-fermer]').addEventListener('click', () => dlg.close());
    dlg.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const l = await api(`${API}/livreurs`, { method: 'POST', body: { nom: $('lvr-nom').value, telephone: $('lvr-tel').value } });
        await chargerLivreurs();
        dlg.close();
        surCree(l);
      } catch (err) { $('lvr-err').hidden = false; $('lvr-err').textContent = err.message; }
    });
    dlg.showModal();
    $('lvr-nom').focus();
  }

  // =========================================================================
  //  Éditeur de tournée
  // =========================================================================
  async function ouvrirEditeur(id, { pilotage = false } = {}) {
    const nav = navigation;
    vueCourante = 'editeur';
    vue.innerHTML = chargement(id ? 'Chargement de la tournée…' : 'Préparation…');
    try {
      const [d] = await Promise.all([id ? api(`${API}/${encodeURIComponent(id)}`) : null, chargerLivreurs()]);
      if (nav !== navigation) return;
      if (d?.clotureeLe) { toast('Tournée clôturée : rouvrez-la pour la modifier.', true); location.hash = `#t/${d.id}`; return; }
      let dernier = null;
      try { dernier = localStorage.getItem('lgdm-tl-dernier-livreur'); } catch {}
      etat.ed = d ? {
        id: d.id, version: d.version, nom: d.nom, date: d.date, idLivreur: d.idLivreur, partageeLe: d.partageeLe,
        livreurInitial: d.idLivreur,
        arrets: d.arrets.map(a => ({ id: a.id, nom: a.nom, adresse: a.adresse, telephone: a.telephone, consignes: a.consignes,
          lat: a.lat, lng: a.lng, verif: a.verif ?? null, statut: a.statut })),
        modifie: false,
      } : {
        id: null, version: null, nom: '', date: etat.aujourdhui,
        idLivreur: etat.livreurs.some(l => l.id === dernier && l.actif) ? dernier : null, arrets: [], modifie: false,
      };
    } catch (e) {
      if (nav === navigation) vue.innerHTML = `<a class="fil" href="#encours">${ico('retour')} Tournées</a>` + blocErreur(e);
      return;
    }
    rendreEditeur();
    if (pilotage) importerPilotage();
    else if (!id) $('ed-nom').focus();
  }

  function rendreEditeur() {
    const ed = etat.ed;
    const options = etat.livreurs.filter(l => l.actif || l.id === ed.idLivreur)
      .map(l => `<option value="${l.id}"${l.id === ed.idLivreur ? ' selected' : ''}>${echap(l.nom)}${l.actif ? '' : ' (désactivé)'}</option>`).join('');
    vue.innerHTML = `
      <a class="fil" href="#${ed.id ? `t/${ed.id}` : 'encours'}">${ico('retour')} ${ed.id ? 'Retour au suivi' : 'Tournées en cours'}</a>
      <div class="bloc">
        <h3>${ico('camion')} ${ed.id ? 'Modifier la tournée' : 'Nouvelle tournée'}</h3>
        <div class="ed-entete">
          <div><label for="ed-nom">Nom de la tournée</label>
            <input type="text" id="ed-nom" maxlength="120" value="${echap(ed.nom)}" placeholder="Ex. Toulouse nord — mardi matin"></div>
          <div><label for="ed-date">Date</label><input type="date" id="ed-date" value="${ed.date}"></div>
          <div><label for="ed-livreur">Livreur</label>
            <div class="livreur-ligne"><div class="select-enveloppe" style="flex:1"><select id="ed-livreur">
              <option value="">— Choisir un livreur —</option>${options}</select></div>
              <button type="button" class="tl-btn" id="ed-nouveau-livreur" title="Ajouter un livreur">${ico('plus')} Livreur</button></div></div>
        </div>
        <p class="carte-soustitre" id="ed-note-livreur" style="margin-top:8px" hidden></p>
      </div>
      <div class="bloc">
        <h3>${ico('liste')} Arrêts <span class="carte-soustitre" id="ed-nb"></span></h3>
        <div class="ed-outils">
          <button type="button" class="tl-btn" id="ed-ajouter">${ico('plus')} Ajouter un arrêt</button>
          <button type="button" class="tl-btn" id="ed-coller">${ico('coller')} Coller une liste</button>
          <button type="button" class="tl-btn" id="ed-importer">${ico('importer')} Importer un fichier</button>
          <span class="sep"></span>
          <button type="button" class="tl-btn discret" id="ed-verifier">${ico('carte')} Vérifier les adresses</button>
        </div>
        <div class="recherche-client" style="margin-top:10px">
          <label for="ed-client" style="margin:0;font-weight:600">Client EasyBeer</label>
          <input type="text" list="dl-clients" id="ed-client" placeholder="Rechercher un client pour l’ajouter avec son adresse…" autocomplete="off">
          <datalist id="dl-clients"></datalist>
          <button type="button" class="tl-btn" id="ed-ajout-client">${ico('plus')} Ajouter</button>
          <span class="carte-soustitre" id="ed-client-msg" role="status"></span>
        </div>
        <p class="carte-soustitre" style="margin:10px 0 6px">Import : Excel (.xlsx, .xls, .ods), CSV, PDF ou liste collée. Un aperçu permet de tout vérifier avant l’ajout.
          Glissez les arrêts par la poignée (ou utilisez les flèches) pour changer l’ordre de passage.</p>
        <div class="resume-adresses" id="ed-resume" style="margin-bottom:8px"></div>
        <ol class="ed-liste" id="ed-liste"></ol>
      </div>
      <div class="ed-pied">
        <span class="info" id="ed-info"></span>
        <a class="tl-btn discret" href="#${ed.id ? `t/${ed.id}` : 'encours'}">Annuler</a>
        <button type="button" class="tl-btn principal" id="ed-enregistrer">${ico('check')} Enregistrer la tournée</button>
      </div>
      <div id="ed-msg" role="alert"></div>`;

    const champ = (id, cle) => $(id).addEventListener('input', e => { ed[cle] = e.target.value; ed.modifie = true; });
    champ('ed-nom', 'nom'); champ('ed-date', 'date');
    $('ed-livreur').addEventListener('change', e => { ed.idLivreur = e.target.value || null; ed.modifie = true; noteLivreur(); });
    $('ed-nouveau-livreur').addEventListener('click', () => creerLivreurRapide(l => {
      ed.idLivreur = l.id; ed.modifie = true;
      const nom = $('ed-nom').value; ed.nom = nom;
      rendreEditeur(); toast(`${l.nom} ajouté`);
    }));
    $('ed-ajouter').addEventListener('click', () => {
      ed.arrets.push({ id: idLocal(), nom: '', adresse: '', telephone: '', consignes: '', verif: null });
      ed.modifie = true; rendreListe();
      const li = $('ed-liste').lastElementChild;
      li?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      li?.querySelector('[data-champ="nom"]')?.focus();
    });
    $('ed-coller').addEventListener('click', ouvrirCollage);
    $('ed-importer').addEventListener('click', () => $('fichier-import').click());
    $('ed-verifier').addEventListener('click', () => verifier(ed.arrets, { forcer: true }));
    $('ed-client').addEventListener('focus', chargerClients, { once: true });
    $('ed-ajout-client').addEventListener('click', ajouterClientEasyBeer);
    $('ed-client').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ajouterClientEasyBeer(); } });
    $('ed-enregistrer').addEventListener('click', enregistrer);
    brancherListe();
    rendreListe();
    noteLivreur();
    // Arrêts jamais vérifiés (créés avant, ou importés sans réseau) : on vérifie.
    const aVerifier = ed.arrets.filter(a => a.adresse && !a.verif && a.statut !== 'livree');
    if (aVerifier.length) verifier(aVerifier);
  }

  function noteLivreur() {
    const ed = etat.ed, n = $('ed-note-livreur');
    if (!n) return;
    const ancien = etat.livreurs.find(l => l.id === ed.livreurInitial);
    if (ed.id && ed.partageeLe && ancien && ed.idLivreur !== ed.livreurInitial) {
      n.hidden = false;
      n.innerHTML = `${ico('alerte')} Le lien déjà envoyé à ${echap(ancien.nom)} n’ouvrira plus cette tournée. Pensez à l’envoyer au nouveau livreur après l’enregistrement.`;
    } else n.hidden = true;
  }

  function etatAdresse(a) {
    if (a._verif) return '<span class="verif attente"><span class="loader" style="width:11px;height:11px"></span> Vérification de l’adresse…</span>';
    if (!a.adresse) return `<span class="verif erreur">${ico('alerte')} Adresse manquante</span>`;
    const v = a.verif && a.verif.adresse === propre(a.adresse) ? a.verif : null;
    if (!v) return '<span class="verif inconnu">Adresse non vérifiée</span>';
    if (v.niveau === 'ok') return `<span class="verif ok">${ico('check')} Adresse reconnue${a.lat != null ? ' · destination GPS exacte' : ''}</span>`;
    const prop = v.suggestion ? `<span class="proposition">Proposition : « ${echap(v.suggestion)} » <button type="button" data-utiliser>Utiliser</button></span>` : '';
    return `<span class="verif ${v.niveau}">${ico('alerte')} ${echap(v.message)}</span>${prop}`;
  }

  function itemEditeur(a, i, n) {
    const verrou = a.statut === 'livree';
    return `<li class="ed-arret ${a.statut ?? ''}" data-i="${i}">
      <div class="ed-poignee" data-poignee title="Glisser pour changer l’ordre"><span class="n">${i + 1}</span>${ico('poignee')}</div>
      <div class="ed-champs">
        <input type="text" data-champ="nom" value="${echap(a.nom)}" maxlength="120" placeholder="Nom du client" aria-label="Nom du client, arrêt ${i + 1}">
        <input type="text" data-champ="adresse" value="${echap(a.adresse)}" maxlength="300" placeholder="Adresse complète : n°, rue, code postal, ville" aria-label="Adresse, arrêt ${i + 1}">
        <div class="ligne2">
          <input type="tel" data-champ="telephone" value="${echap(a.telephone)}" maxlength="40" placeholder="Téléphone" aria-label="Téléphone, arrêt ${i + 1}">
          <textarea data-champ="consignes" rows="1" maxlength="1000" placeholder="Consignes de livraison : accès, horaires, code portail…" aria-label="Consignes, arrêt ${i + 1}">${echap(a.consignes)}</textarea>
        </div>
        <div class="ed-etat" data-etat>${etatAdresse(a)}${a.statut && a.statut !== 'a_livrer' ? ' ' + pastilleArret(a.statut) : ''}</div>
      </div>
      <div class="ed-actions">
        <button type="button" class="tl-btn carre discret" data-monter aria-label="Monter l’arrêt ${i + 1}"${i === 0 ? ' disabled' : ''}>${ico('haut')}</button>
        <button type="button" class="tl-btn carre discret" data-descendre aria-label="Descendre l’arrêt ${i + 1}"${i === n - 1 ? ' disabled' : ''}>${ico('chevron')}</button>
        <button type="button" class="tl-btn carre discret danger" data-suppr aria-label="Supprimer l’arrêt ${i + 1}"${verrou ? ' disabled title="Déjà livré : remettez-le à livrer depuis le suivi pour le retirer"' : ''}>${ico('corbeille')}</button>
      </div>
    </li>`;
  }

  function rendreListe() {
    const ed = etat.ed, liste = $('ed-liste');
    if (!liste) return;
    liste.innerHTML = ed.arrets.length ? ed.arrets.map((a, i) => itemEditeur(a, i, ed.arrets.length)).join('')
      : `<li class="vide-bloc" style="padding:28px">${ico('carte')}<span>Aucun arrêt pour l’instant : ajoutez les clients à la main, collez une liste ou importez un fichier.</span></li>`;
    majResume();
  }

  function majEtats() {
    document.querySelectorAll('#ed-liste .ed-arret').forEach(li => {
      const a = etat.ed.arrets[+li.dataset.i];
      if (a) li.querySelector('[data-etat]').innerHTML = etatAdresse(a) + (a.statut && a.statut !== 'a_livrer' ? ' ' + pastilleArret(a.statut) : '');
    });
    majResume();
  }

  function compterAdresses(arrets) {
    const c = { ok: 0, avertissement: 0, erreur: 0, autre: 0 };
    for (const a of arrets) {
      const v = a.verif && a.verif.adresse === propre(a.adresse) ? a.verif : null;
      if (!a.adresse) c.erreur++;
      else if (!v || a._verif || v.niveau === 'inconnu') c.autre++;
      else c[v.niveau]++;
    }
    return c;
  }
  const resumeAdresses = c => [
    c.ok ? `<span class="o">${ico('check')} ${pluriel(c.ok, 'adresse reconnue', 'adresses reconnues')}</span>` : '',
    c.avertissement ? `<span class="a">${ico('alerte')} ${pluriel(c.avertissement, 'à vérifier', 'à vérifier')}</span>` : '',
    c.erreur ? `<span class="e">${ico('alerte')} ${pluriel(c.erreur, 'incomplète ou introuvable', 'incomplètes ou introuvables')}</span>` : '',
    c.autre ? `<span>${pluriel(c.autre, 'non vérifiée', 'non vérifiées')}</span>` : '',
  ].filter(Boolean).join('');

  function majResume() {
    const ed = etat.ed;
    if (!$('ed-resume')) return;
    $('ed-nb').textContent = `(${ed.arrets.length})`;
    $('ed-resume').innerHTML = ed.arrets.length ? resumeAdresses(compterAdresses(ed.arrets)) : '';
    $('ed-info').textContent = ed.arrets.length ? `${pluriel(ed.arrets.length, 'arrêt')}${ed.modifie ? ' · modifications non enregistrées' : ''}` : '';
  }

  function brancherListe() {
    const liste = $('ed-liste'), ed = etat.ed;
    liste.addEventListener('input', e => {
      const c = e.target.dataset.champ;
      if (!c) return;
      const a = ed.arrets[+e.target.closest('.ed-arret').dataset.i];
      a[c] = e.target.value;
      ed.modifie = true;
      if (c === 'adresse') { a.verif = null; delete a.lat; delete a.lng; majEtats(); } else majResume();
    });
    liste.addEventListener('change', e => {
      const c = e.target.dataset.champ;
      const a = ed.arrets[+e.target.closest('.ed-arret')?.dataset.i];
      if (!a) return;
      if (c === 'adresse') { a.adresse = propre(a.adresse); e.target.value = a.adresse; verifier([a]); }
      if (c === 'telephone' && a.telephone) { a.telephone = I.formaterTel(a.telephone); e.target.value = a.telephone; }
    });
    liste.addEventListener('click', e => {
      const li = e.target.closest('.ed-arret');
      if (!li) return;
      const i = +li.dataset.i;
      if (e.target.closest('[data-monter]') && i > 0) deplacer(i, i - 1);
      else if (e.target.closest('[data-descendre]') && i < ed.arrets.length - 1) deplacer(i, i + 1);
      else if (e.target.closest('[data-suppr]')) {
        const a = ed.arrets[i];
        if ((a.nom || a.adresse) && !confirm(`Retirer « ${a.nom || a.adresse} » de la tournée ?`)) return;
        ed.arrets.splice(i, 1); ed.modifie = true; rendreListe();
      } else if (e.target.closest('[data-utiliser]')) {
        const a = ed.arrets[i];
        a.adresse = a.verif.suggestion; a.verif = null; ed.modifie = true;
        li.querySelector('[data-champ="adresse"]').value = a.adresse;
        verifier([a]);
      }
    });
    brancherGlisser(liste);
  }

  function deplacer(de, vers) {
    const ed = etat.ed;
    const [a] = ed.arrets.splice(de, 1);
    ed.arrets.splice(vers, 0, a);
    ed.modifie = true;
    rendreListe();
    // Le focus suit l'arrêt déplacé : on peut enchaîner au clavier.
    const b = $('ed-liste').children[vers]?.querySelector(vers < de ? '[data-monter]' : '[data-descendre]');
    (b && !b.disabled ? b : $('ed-liste').children[vers]?.querySelector('[data-champ="nom"]'))?.focus();
  }

  // Glisser-déposer par la poignée : souris, doigt ou stylet (Pointer Events).
  function brancherGlisser(liste) {
    let g = null;
    liste.addEventListener('pointerdown', e => {
      const p = e.target.closest('[data-poignee]');
      if (!p || e.button > 0) return;
      e.preventDefault();
      const li = p.closest('.ed-arret');
      p.setPointerCapture(e.pointerId);
      g = { li, p, de: +li.dataset.i };
      li.classList.add('glisse');
    });
    liste.addEventListener('pointermove', e => {
      if (!g) return;
      const y = e.clientY;
      const autres = [...liste.children].filter(x => x !== g.li);
      const avant = autres.find(x => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (avant) { if (g.li.nextElementSibling !== avant) liste.insertBefore(g.li, avant); }
      else if (liste.lastElementChild !== g.li) liste.appendChild(g.li);
      if (y < 70) window.scrollBy(0, -12); else if (y > innerHeight - 90) window.scrollBy(0, 12);
    });
    const fin = () => {
      if (!g) return;
      const ordre = [...liste.children].map(li => +li.dataset.i);
      const change = ordre.some((v, k) => v !== k);
      g.li.classList.remove('glisse');
      g = null;
      if (change) { etat.ed.arrets = ordre.map(k => etat.ed.arrets[k]); etat.ed.modifie = true; }
      rendreListe();
    };
    liste.addEventListener('pointerup', fin);
    liste.addEventListener('pointercancel', fin);
  }

  // --- Vérification des adresses ---------------------------------------------
  let verificationsEnCours = Promise.resolve();
  function verifier(arrets, { forcer = false, apres = majEtats } = {}) {
    const cibles = arrets.filter(a => a.adresse && (forcer || !(a.verif && a.verif.adresse === propre(a.adresse))));
    if (!cibles.length) { apres(); return Promise.resolve(); }
    cibles.forEach(a => { a._verif = true; });
    apres();
    const p = (async () => {
      const adresses = cibles.map(a => propre(a.adresse));
      try {
        const { resultats } = await api(`${API}/verifier-adresses`, { method: 'POST', body: { adresses } });
        cibles.forEach((a, k) => {
          const r = resultats[k];
          if (!r || propre(a.adresse) !== adresses[k]) return;      // modifiée entre-temps
          a.verif = { niveau: r.niveau, message: r.message, suggestion: r.suggestion ?? '', adresse: r.adresse };
          if (r.niveau === 'ok' && r.lat != null) { a.lat = r.lat; a.lng = r.lng; } else { delete a.lat; delete a.lng; }
        });
      } catch {
        cibles.forEach((a, k) => {
          if (propre(a.adresse) !== adresses[k]) return;
          const f = I.controleForme(a.adresse);
          a.verif = { niveau: f.niveau === 'ok' ? 'inconnu' : f.niveau, message: f.message || 'Vérification en ligne indisponible : relisez l’adresse', adresse: adresses[k] };
        });
      }
      cibles.forEach(a => { delete a._verif; });
      apres();
    })();
    verificationsEnCours = Promise.all([verificationsEnCours, p]);
    return p;
  }

  // --- Ajout d'un client EasyBeer ----------------------------------------------
  async function chargerClients() {
    if (etat.clients) return etat.clients;
    const msg = $('ed-client-msg');
    if (msg) msg.textContent = 'Chargement des clients…';
    try {
      etat.clients = await api('/api/clients');
      if ($('dl-clients')) $('dl-clients').innerHTML = etat.clients.map(c => `<option value="${echap(c.nom)}">`).join('');
      if (msg) msg.textContent = '';
    } catch (e) { if (msg) msg.textContent = `Clients EasyBeer indisponibles (${e.message}) : saisissez l’arrêt à la main.`; }
    return etat.clients;
  }

  async function ajouterClientEasyBeer() {
    const ed = etat.ed, champ = $('ed-client'), msg = $('ed-client-msg');
    const nom = champ.value.trim();
    if (!nom) return;
    await chargerClients();
    const c = etat.clients?.find(x => x.nom === nom) ?? etat.clients?.find(x => x.nom.toLowerCase() === nom.toLowerCase());
    if (!c) { msg.textContent = 'Choisissez un client dans la liste, ou utilisez « Ajouter un arrêt ».'; return; }
    msg.textContent = 'Lecture de la fiche client…';
    let infos = {};
    try { infos = await api(`/api/cache/client-infos/${c.id}`); } catch {}
    const tel = (String(infos.contact ?? '').match(I.RE_TEL) ?? [''])[0];
    const a = { id: idLocal(), nom: c.nom, adresse: propre(infos.adresse ?? ''), telephone: tel ? I.formaterTel(tel) : '', consignes: '', verif: null };
    ed.arrets.push(a); ed.modifie = true;
    champ.value = '';
    msg.textContent = a.adresse ? '' : 'Fiche sans adresse : complétez-la.';
    rendreListe();
    $('ed-liste').lastElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (a.adresse) verifier([a]);
  }

  // --- Enregistrement ----------------------------------------------------------
  async function enregistrer() {
    const ed = etat.ed, msg = $('ed-msg'), b = $('ed-enregistrer');
    msg.innerHTML = '';
    ed.nom = $('ed-nom').value.trim(); ed.date = $('ed-date').value;
    if (!ed.nom) { $('ed-nom').focus(); toast('Donnez un nom à la tournée.', true); return; }
    if (!ed.date) { $('ed-date').focus(); toast('Choisissez la date de la tournée.', true); return; }
    const vides = ed.arrets.filter(a => !propre(a.nom) && !propre(a.adresse));
    if (vides.length) { ed.arrets = ed.arrets.filter(a => !vides.includes(a)); rendreListe(); }
    if (!ed.arrets.length && !confirm('La tournée ne contient aucun arrêt. L’enregistrer quand même ?')) return;
    b.disabled = true; b.innerHTML = '<span class="loader"></span> Enregistrement…';
    await verificationsEnCours;
    const c = compterAdresses(ed.arrets);
    if (c.erreur && !confirm(`${pluriel(c.erreur, 'adresse est incomplète ou introuvable', 'adresses sont incomplètes ou introuvables')} : le livreur risque de ne pas trouver ${c.erreur > 1 ? 'ces clients' : 'ce client'}.\n\nEnregistrer quand même ?`)) {
      b.disabled = false; b.innerHTML = `${ico('check')} Enregistrer la tournée`; return;
    }
    if (!ed.idLivreur && !confirm('Aucun livreur choisi : la tournée ne pourra pas être envoyée tant qu’un livreur ne lui est pas attribué.\n\nEnregistrer quand même ?')) {
      b.disabled = false; b.innerHTML = `${ico('check')} Enregistrer la tournée`; return;
    }
    const corps = {
      nom: ed.nom, date: ed.date, idLivreur: ed.idLivreur, version: ed.version,
      arrets: ed.arrets.map(a => ({ id: a.id, nom: a.nom, adresse: propre(a.adresse), telephone: a.telephone, consignes: a.consignes,
        lat: a.lat, lng: a.lng, verif: a.verif })),
    };
    try {
      const d = await api(ed.id ? `${API}/${ed.id}` : API, { method: ed.id ? 'PUT' : 'POST', body: corps });
      ed.modifie = false;
      try { if (ed.idLivreur) localStorage.setItem('lgdm-tl-dernier-livreur', ed.idLivreur); } catch {}
      etat.actives = null;
      toast(ed.id ? 'Tournée enregistrée' : 'Tournée créée : envoyez maintenant le lien au livreur');
      location.hash = `#t/${d.id}`;
    } catch (e) {
      b.disabled = false; b.innerHTML = `${ico('check')} Enregistrer la tournée`;
      msg.innerHTML = `<div class="msg-erreur">${ico('alerte')}<span><b>La tournée n’a pas été enregistrée.</b> ${echap(e.message)}</span>
        ${e.data?.conflit ? `<button class="tl-btn mini" onclick="location.reload()">Recharger la tournée</button>`
          : '<button class="tl-btn mini" id="ed-reessayer">Réessayer</button>'}</div>`;
      $('ed-reessayer')?.addEventListener('click', enregistrer);
      msg.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // =========================================================================
  //  Import : collage, fichier, Pilotage → aperçu
  // =========================================================================
  function ouvrirCollage() {
    const dlg = $('dlg-petit');
    dlg.innerHTML = `<div class="dlg"><div class="dlg-tete"><div><h2>Coller une liste de livraisons</h2>
        <p>Depuis un tableur, un mail ou un document : une ligne par client, ou un paragraphe par client (nom, adresse, téléphone, consignes).</p></div>
        <button class="tl-btn carre discret" data-fermer aria-label="Fermer">${ico('croix')}</button></div>
      <div class="dlg-corps">
        <label for="colle-texte" class="sr-only">Liste à analyser</label>
        <textarea id="colle-texte" rows="12" placeholder="Bar Le Central - 12 place de la République 31150 Bruguières - 05 61 00 00 00 - livrer par la cour&#10;Cave Martin - 5 bis rue de Metz 31000 Toulouse - 06 12 34 56 78"></textarea>
        <p class="msg-erreur" id="colle-err" hidden></p>
      </div>
      <div class="dlg-pied"><span class="info"></span><button class="tl-btn" data-fermer>Annuler</button>
        <button class="tl-btn principal" id="colle-ok">Analyser la liste</button></div></div>`;
    dlg.querySelectorAll('[data-fermer]').forEach(b => b.addEventListener('click', () => dlg.close()));
    $('colle-ok').addEventListener('click', () => {
      const r = I.lireTexte($('colle-texte').value);
      if (!r.arrets.length) { $('colle-err').hidden = false; $('colle-err').textContent = 'Aucun client reconnu dans ce texte.'; return; }
      dlg.close();
      ouvrirApercu(r, 'Liste collée');
    });
    dlg.showModal();
    $('colle-texte').focus();
  }

  $('fichier-import').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !etat.ed) return;
    toast(`Lecture de « ${f.name} »…`);
    try {
      const lu = await I.lireFichier(f);
      let r;
      if (lu.feuilles) { r = I.lireTableau(lu.feuilles[0].lignes); r.feuilles = lu.feuilles; }
      else r = I.lireTexte(lu.texte);
      if (!r.arrets.length && !r.feuilles) throw new Error('aucun client reconnu dans ce fichier');
      document.querySelector('.toast')?.remove();
      ouvrirApercu(r, f.name);
    } catch (err) { toast(`Import impossible : ${err.message}`, true); }
  });

  function importerPilotage() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem('lgdm-tl-import') ?? 'null'); localStorage.removeItem('lgdm-tl-import'); } catch {}
    if (!d?.arrets?.length) { toast('Aucune tournée du Pilotage à reprendre.', true); return; }
    const ed = etat.ed;
    if (!ed.nom) { ed.nom = d.nom ?? ''; $('ed-nom').value = ed.nom; }
    if (d.date) { ed.date = d.date; $('ed-date').value = d.date; }
    ed.modifie = true;
    ouvrirApercu({ arrets: d.arrets.map(a => ({ nom: a.nom ?? '', adresse: propre(a.adresse), telephone: a.telephone ? I.formaterTel(a.telephone) : '', consignes: a.consignes ?? '' })), forme: 'pilotage' },
      `Pilotage — ${d.nom ?? 'tournée calculée'}`);
  }

  // --- Aperçu ---------------------------------------------------------------------
  let apercu = null;
  const cleDoublon = a => `${propre(a.nom).toLowerCase()}|${propre(a.adresse).toLowerCase()}`;

  function ouvrirApercu(r, source) {
    const existants = new Set(etat.ed.arrets.map(cleDoublon));
    const vus = new Set();
    apercu = { source, r, feuille: 0, filtre: false, mode: 'ajouter', arrets: [] };
    apercu.arrets = r.arrets.map(a => {
      const cle = cleDoublon(a);
      const note = existants.has(cle) ? 'Déjà dans la tournée' : vus.has(cle) ? 'Doublon dans la liste'
        : !a.adresse && !a.telephone ? 'Ni adresse ni téléphone : titre ou ligne à compléter ?' : '';
      vus.add(cle);
      return { ...a, id: idLocal(), verif: null, inclure: !note, note };
    });
    rendreApercu();
    const dlg = $('dlg-apercu');
    if (!dlg.open) dlg.showModal();
    verifier(apercu.arrets, { apres: majApercuEtats });
  }

  function selectColonne(champ, libelle) {
    const r = apercu.r, j = r.colonnes?.[champ];
    const noms = Array.from({ length: r.largeur }, (_, k) => r.entete?.[k] || `Colonne ${String.fromCharCode(65 + k)}`);
    return `<div><label for="col-${champ}">${libelle}</label><div class="select-enveloppe"><select id="col-${champ}" data-colonne="${champ}">
      <option value="">— aucune —</option>${noms.map((n, k) => `<option value="${k}"${j === k ? ' selected' : ''}>${echap(n)}</option>`).join('')}</select></div></div>`;
  }

  function rendreApercu() {
    const dlg = $('dlg-apercu'), r = apercu.r, ed = etat.ed;
    const tab = r.forme === 'tableau' && r.lignes;
    const restants = ed.arrets.filter(a => !a.statut || a.statut === 'a_livrer').length;
    dlg.innerHTML = `<div class="dlg">
      <div class="dlg-tete"><div><h2 id="apercu-titre">Aperçu de l’import — vérifiez avant d’ajouter</h2>
        <p>${echap(apercu.source)} · ${pluriel(apercu.arrets.length, 'client reconnu', 'clients reconnus')}.
          Corrigez directement dans le tableau ; décochez ce qui ne doit pas être livré.</p></div>
        <button class="tl-btn carre discret" data-fermer aria-label="Fermer l’aperçu">${ico('croix')}</button></div>
      <div class="dlg-corps">
        ${r.feuilles?.length > 1 ? `<div style="max-width:320px"><label for="ap-feuille">Feuille du classeur</label><div class="select-enveloppe"><select id="ap-feuille">
          ${r.feuilles.map((f, k) => `<option value="${k}"${k === apercu.feuille ? ' selected' : ''}>${echap(f.nom)}</option>`).join('')}</select></div></div>` : ''}
        ${tab ? `<div class="colonnes-import" aria-label="Colonnes du fichier">
          ${selectColonne('nom', 'Nom du client')}${selectColonne('adresse', 'Adresse')}${selectColonne('cp', 'Code postal')}
          ${selectColonne('ville', 'Ville')}${selectColonne('telephone', 'Téléphone')}${selectColonne('consignes', 'Consignes')}
        </div>` : ''}
        <div class="resume-adresses" id="ap-resume"></div>
        <label class="options-import" style="margin:0"><span style="display:inline-flex;gap:6px;align-items:center">
          <input type="checkbox" id="ap-filtre"${apercu.filtre ? ' checked' : ''}> Afficher seulement les adresses à vérifier ou à corriger</span></label>
        <table class="apercu-table">
          <thead><tr><th><span class="sr-only">Ajouter</span></th><th>N°</th><th class="c-nom">Client</th><th class="c-adr">Adresse complète</th>
            <th class="c-tel">Téléphone</th><th class="c-cons">Consignes</th></tr></thead>
          <tbody id="ap-corps"></tbody>
        </table>
      </div>
      <div class="dlg-pied">
        <span class="info">
          ${restants ? `<span class="options-import">
            <label><input type="radio" name="ap-mode" value="ajouter"${apercu.mode === 'ajouter' ? ' checked' : ''}> Ajouter à la suite des ${pluriel(ed.arrets.length, 'arrêt')}</label>
            <label><input type="radio" name="ap-mode" value="remplacer"${apercu.mode === 'remplacer' ? ' checked' : ''}> Remplacer les arrêts à livrer</label></span>` : ''}
        </span>
        <button class="tl-btn" data-fermer>Annuler</button>
        <button class="tl-btn principal" id="ap-ok"></button>
      </div></div>`;

    dlg.querySelectorAll('[data-fermer]').forEach(b => b.addEventListener('click', () => {
      if (confirm('Abandonner cet import ?')) dlg.close();
    }));
    $('ap-feuille')?.addEventListener('change', e => {
      const f = r.feuilles[+e.target.value];
      const n = I.lireTableau(f.lignes); n.feuilles = r.feuilles;
      const feuille = +e.target.value;
      ouvrirApercu(n, apercu.source); apercu.feuille = feuille; rendreApercu();
    });
    dlg.querySelectorAll('[data-colonne]').forEach(s => s.addEventListener('change', () => {
      const cols = { ...r.colonnes };
      const v = s.value === '' ? undefined : +s.value;
      // Une colonne ne sert qu'à un champ à la fois.
      for (const k of Object.keys(cols)) if (k !== 'autres' && cols[k] === v) delete cols[k];
      if (v === undefined) delete cols[s.dataset.colonne]; else cols[s.dataset.colonne] = v;
      delete cols.autres;
      const n = I.lireTableau(r.lignes, cols); n.feuilles = r.feuilles;
      const feuille = apercu.feuille;
      ouvrirApercu(n, apercu.source); apercu.feuille = feuille; rendreApercu();
    }));
    $('ap-filtre').addEventListener('change', e => { apercu.filtre = e.target.checked; rendreLignesApercu(); });
    dlg.querySelectorAll('[name="ap-mode"]').forEach(x => x.addEventListener('change', () => { apercu.mode = x.value; }));
    $('ap-ok').addEventListener('click', validerApercu);
    brancherApercu();
    rendreLignesApercu();
  }

  function niveauApercu(a) {
    if (!a.adresse) return 'erreur';
    const v = a.verif && a.verif.adresse === propre(a.adresse) ? a.verif : null;
    return v?.niveau ?? 'inconnu';
  }

  function rendreLignesApercu() {
    const corps = $('ap-corps');
    if (!corps) return;
    const lignes = apercu.arrets.map((a, i) => ({ a, i })).filter(({ a }) => !apercu.filtre || ['erreur', 'avertissement'].includes(niveauApercu(a)) || !a.nom);
    corps.innerHTML = lignes.length ? lignes.map(({ a, i }) => {
      const n = niveauApercu(a);
      return `<tr data-i="${i}" class="${a.inclure ? '' : 'exclu'} ${a.inclure && ['erreur', 'avertissement'].includes(n) ? `ap-${n}` : ''}">
        <td><input type="checkbox" data-inclure${a.inclure ? ' checked' : ''} aria-label="Ajouter ${echap(a.nom || 'cet arrêt')}"></td>
        <td style="font-weight:700;color:var(--accent-texte)">${i + 1}</td>
        <td class="c-nom"><input type="text" data-champ="nom" value="${echap(a.nom)}" placeholder="Nom manquant" aria-label="Nom du client ${i + 1}">
          ${!a.nom ? `<div class="verif erreur" style="margin-top:3px">${ico('alerte')} Nom manquant</div>` : ''}
          ${a.note ? `<div class="verif avertissement" style="margin-top:3px">${ico('alerte')} ${echap(a.note)}</div>` : ''}</td>
        <td class="c-adr"><input type="text" data-champ="adresse" value="${echap(a.adresse)}" placeholder="Adresse manquante" aria-label="Adresse ${i + 1}">
          <div data-etat style="margin-top:3px;display:flex;gap:6px;flex-wrap:wrap">${etatAdresse(a)}</div></td>
        <td class="c-tel"><input type="text" data-champ="telephone" value="${echap(a.telephone)}" aria-label="Téléphone ${i + 1}"></td>
        <td class="c-cons"><textarea data-champ="consignes" rows="1" aria-label="Consignes ${i + 1}">${echap(a.consignes)}</textarea></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="carte-soustitre" style="padding:16px">Toutes les adresses sont reconnues.</td></tr>';
    majApercuResume();
  }

  function majApercuEtats() {
    document.querySelectorAll('#ap-corps tr[data-i]').forEach(tr => {
      const a = apercu.arrets[+tr.dataset.i];
      tr.querySelector('[data-etat]').innerHTML = etatAdresse(a);
      const n = niveauApercu(a);
      tr.classList.toggle('ap-erreur', a.inclure && n === 'erreur');
      tr.classList.toggle('ap-avertissement', a.inclure && n === 'avertissement');
    });
    majApercuResume();
  }

  function majApercuResume() {
    const choisis = apercu.arrets.filter(a => a.inclure);
    if ($('ap-resume')) $('ap-resume').innerHTML = `<b>${pluriel(choisis.length, 'arrêt sélectionné', 'arrêts sélectionnés')}</b>` + resumeAdresses(compterAdresses(choisis));
    const b = $('ap-ok');
    if (b) { b.textContent = `Ajouter ${pluriel(choisis.length, 'arrêt')} à la tournée`; b.disabled = !choisis.length; }
  }

  function brancherApercu() {
    const corps = $('ap-corps');
    corps.addEventListener('input', e => {
      const a = apercu.arrets[+e.target.closest('tr')?.dataset.i];
      if (!a) return;
      if (e.target.dataset.inclure !== undefined) { a.inclure = e.target.checked; e.target.closest('tr').classList.toggle('exclu', !a.inclure); majApercuEtats(); return; }
      const c = e.target.dataset.champ;
      if (!c) return;
      a[c] = e.target.value;
      if (c === 'adresse') { a.verif = null; delete a.lat; delete a.lng; majApercuEtats(); }
    });
    corps.addEventListener('change', e => {
      const a = apercu.arrets[+e.target.closest('tr')?.dataset.i];
      if (a && e.target.dataset.champ === 'adresse') { a.adresse = propre(a.adresse); verifier([a], { apres: majApercuEtats }); }
    });
    corps.addEventListener('click', e => {
      if (!e.target.closest('[data-utiliser]')) return;
      const tr = e.target.closest('tr'), a = apercu.arrets[+tr.dataset.i];
      a.adresse = a.verif.suggestion; a.verif = null;
      tr.querySelector('[data-champ="adresse"]').value = a.adresse;
      verifier([a], { apres: majApercuEtats });
    });
  }

  function validerApercu() {
    const ed = etat.ed;
    const choisis = apercu.arrets.filter(a => a.inclure && (propre(a.nom) || propre(a.adresse)))
      .map(({ inclure, note, ...a }) => ({ ...a, adresse: propre(a.adresse) }));
    if (!choisis.length) return;
    if (apercu.mode === 'remplacer') ed.arrets = ed.arrets.filter(a => a.statut && a.statut !== 'a_livrer');
    ed.arrets.push(...choisis);
    ed.modifie = true;
    $('dlg-apercu').close();
    rendreListe();
    toast(`${pluriel(choisis.length, 'arrêt ajouté', 'arrêts ajoutés')} : pensez à enregistrer la tournée`);
    // Vérifications encore en cours dans l'aperçu : leur résultat met à jour la liste.
    const enCours = choisis.filter(a => a._verif);
    if (enCours.length) verificationsEnCours.then(() => majEtats());
  }

  // =========================================================================
  //  Navigation et rafraîchissement
  // =========================================================================
  function route() {
    navigation++;
    hashPrecedent = location.hash;
    const h = decodeURIComponent(location.hash.slice(1));
    let m;
    if (h === 'historique') return afficherHistorique();
    if (h === 'livreurs') return afficherLivreurs();
    if (h === 'nouvelle') return ouvrirEditeur(null);
    if (h === 'import-pilotage') return ouvrirEditeur(null, { pilotage: true });
    if ((m = h.match(/^modifier\/([\w-]+)$/))) return ouvrirEditeur(m[1]);
    if ((m = h.match(/^t\/([\w-]+)$/))) return afficherDetail(m[1]);
    return afficherActives();
  }

  window.addEventListener('hashchange', () => {
    if (vueCourante === 'editeur' && etat.ed?.modifie && !confirm('Quitter la tournée sans enregistrer les modifications ?')) {
      history.replaceState(null, '', hashPrecedent || location.pathname);
      return;
    }
    if (vueCourante === 'editeur') etat.ed = null;
    route();
  });
  window.addEventListener('beforeunload', e => {
    if (vueCourante === 'editeur' && etat.ed?.modifie) { e.preventDefault(); e.returnValue = ''; }
  });

  // Suivi en direct : la brasserie voit les validations du livreur arriver.
  function rafraichir() {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    if (vueCourante === 'encours') afficherActives({ silencieux: true });
    else if (vueCourante === 'detail' && etat.detail) afficherDetail(etat.detail.id, { silencieux: true });
  }
  setInterval(rafraichir, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rafraichir(); });

  route();
})();
