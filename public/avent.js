// ===========================================================================
//  Calendrier de l'Avent du Gué — page de l'équipe
// ===========================================================================
// Une porte par semaine. Pour chaque semaine : le cadeau, les clients fidèles
// venus à la brasserie (importés depuis l'export de la carte de fidélité),
// puis le tirage, montré en plein écran au bar ou filmé pour une story.
//
// Le tirage lui-même est fait et enregistré par le serveur (avent.js à la
// racine) : l'animation ne fait que révéler le résultat qu'il a renvoyé.
(() => {
  const $ = id => document.getElementById(id);
  const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const MOINS_ANIM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CDN_XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const sansAccent = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const pluriel = (n, un, plusieurs = un + 's') => `${n} ${n > 1 ? plusieurs : un}`;

  const now = new Date();
  const ANNEE = Number(new URLSearchParams(location.search).get('annee'))
    || (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());

  let etat = null;           // { annee, reglages, semaines, aujourdhui, motifs }
  let choisie = null;        // id de la semaine affichée
  let filtre = '';
  let ajoutOuvert = false;
  let datesOuvertes = false;

  // --- Réseau ---------------------------------------------------------------
  async function api(chemin, { methode = 'GET', corps } = {}) {
    const r = await fetch(`/api/avent${chemin}`, {
      method: methode,
      headers: corps ? { 'Content-Type': 'application/json' } : {},
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error ?? `Erreur ${r.status}`), { status: r.status });
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

  // --- Dates ----------------------------------------------------------------
  const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const dateDe = j => new Date(`${j}T12:00:00`);
  const fmtCourt = j => { const d = dateDe(j); return `${d.getDate()} ${MOIS[d.getMonth()]}`; };
  const fmtJour = j => { const d = dateDe(j); return `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`; };
  const fmtJourMini = j => { const d = dateDe(j); return `${JOURS[d.getDay()]} ${d.getDate()}`; };
  const fmtHeure = t => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const jourLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const jourParis = d => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

  // --- Personnes ------------------------------------------------------------
  // Même calcul que le serveur : téléphone, sinon e-mail, sinon nom.
  function clePersonne({ tel, email, nom }) {
    const chiffres = String(tel ?? '').replace(/\D/g, '');
    if (chiffres.length >= 9) return 't' + chiffres.slice(-9);
    const mail = String(email ?? '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+$/.test(mail)) return 'm' + mail;
    const n = sansAccent(nom).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ');
    return n ? 'n' + n : '';
  }

  // Nom montré à l'écran et en story : prénom + initiale (« Luccio M. »).
  // Gère « MARTIN Luccio » (nom de famille en capitales devant).
  const majuscule = m => m.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  function affiche(nom) {
    const mots = String(nom ?? '').trim().split(/\s+/).filter(Boolean);
    if (!mots.length) return '?';
    if (/@/.test(mots[0])) return mots[0].split('@')[0];
    if (mots.length === 1) return majuscule(mots[0]);
    const enCapitales = m => m.length > 1 && m === m.toUpperCase() && /\p{Lu}/u.test(m);
    let prenom, famille;
    if (enCapitales(mots[0]) && !enCapitales(mots[mots.length - 1])) { famille = mots[0]; prenom = mots.slice(1).join(' '); }
    else { prenom = mots.slice(0, -1).join(' '); famille = mots[mots.length - 1]; }
    return `${majuscule(prenom)} ${famille[0].toUpperCase()}.`;
  }
  const prenomDe = nom => affiche(nom).replace(/\s+\S\.$/, '');

  function formaterTel(t) {
    const s = String(t ?? '').trim();
    let d = s.replace(/[^\d+]/g, '');
    if (!d) return '';
    if (d.startsWith('0033')) d = '+33' + d.slice(4);
    if (/^33\d{9}$/.test(d)) d = '+' + d;
    if (/^\+33\d{9}$/.test(d)) d = '0' + d.slice(3);
    if (/^[1-9]\d{8}$/.test(d)) d = '0' + d;          // 0 de tête perdu par Excel
    if (/^0\d{9}$/.test(d)) return d.replace(/(\d{2})(?=\d)/g, '$1 ');
    return s.slice(0, 30);
  }
  const telLien = t => {
    const d = String(t ?? '').replace(/[^\d+]/g, '');
    return /^0\d{9}$/.test(d) ? '+33' + d.slice(1) : d;
  };

  // --- État du calendrier ---------------------------------------------------
  const semaineChoisie = () => etat.semaines.find(s => s.id === choisie) ?? etat.semaines[0];
  function statut(s) {
    if (s.tirage) return 'tiree';
    if (etat.aujourdhui < s.debut) return 'a_venir';
    if (etat.aujourdhui <= s.fin) return 'en_cours';
    return 'a_tirer';
  }
  const LIB_STATUT = { a_venir: 'À venir', en_cours: 'En cours', a_tirer: 'À tirer', tiree: 'Tirée' };
  const LIB_REMISE = { a_prevenir: 'À prévenir', prevenu: 'Prévenu', remis: 'Cadeau remis' };

  // Qui est dans le tirage : même règle que le serveur, pour l'affichage et
  // les noms qui défilent pendant l'animation.
  function eligibilite(s, { retirage = false } = {}) {
    const autres = new Map();
    if (etat.reglages.exclureGagnants) {
      for (const x of etat.semaines) if (x.id !== s.id && x.tirage) autres.set(x.tirage.gagnant.cle, x);
    }
    const deja = new Set((s.historique ?? []).map(h => h.gagnant.cle));
    if (retirage && s.tirage) deja.add(s.tirage.gagnant.cle);
    const eligibles = s.participants.filter(p => !p.exclu && !autres.has(p.cle) && !deja.has(p.cle));
    const parPassage = etat.reglages.chances === 'passage';
    return {
      eligibles, autres,
      chances: parPassage ? eligibles.reduce((a, p) => a + Math.max(1, p.passages), 0) : eligibles.length,
      exclus: s.participants.filter(p => p.exclu).length,
      dejaGagnants: s.participants.filter(p => autres.has(p.cle)).length,
    };
  }

  function remplacer(sem) {
    const i = etat.semaines.findIndex(s => s.id === sem.id);
    if (i >= 0) etat.semaines[i] = sem; else etat.semaines.push(sem);
  }

  // =========================================================================
  //  Affichage
  // =========================================================================
  function rendre() {
    const s = semaineChoisie();
    choisie = s.id;
    $('vue').innerHTML = `
      ${enTete()}
      <div class="av-portes" role="tablist" aria-label="Semaines du calendrier">${etat.semaines.map(porte).join('')}</div>
      <div class="av-grille">
        <div class="av-colonne">
          <section aria-labelledby="sem-titre">${blocSemaine(s)}</section>
          <section aria-labelledby="part-titre">${blocParticipants(s)}</section>
        </div>
        <aside class="av-colonne">${blocRegles()}</aside>
      </div>`;
  }

  const enTete = () => `
    <div class="av-tete">
      <img src="logo.png" alt="">
      <div class="av-tete-texte">
        <span class="av-pilule">Jeu de Noël ${etat.annee}</span>
        <h2>Calendrier de l’Avent <em>du Gué</em></h2>
        <p>Chaque semaine, un client fidèle venu boire un coup à la brasserie gagne le cadeau de la semaine.
          Importez l’export de la carte de fidélité, puis lancez le tirage.</p>
      </div>
      <div class="av-tete-actions">
        <button class="av-btn principal" data-action="importer">${ico('importer')} Importer l’export fidélité</button>
        <button class="av-btn" data-action="coller">${ico('coller')} Coller une liste</button>
      </div>
    </div>`;

  function porte(s) {
    const st = statut(s);
    const t = s.tirage;
    return `<button type="button" class="av-porte ${st}" role="tab" aria-selected="${s.id === choisie}" data-action="choisir" data-id="${s.id}">
      <span class="av-porte-haut"><span class="av-porte-num" aria-hidden="true">${s.numero}</span><span class="st ${st}">${LIB_STATUT[st]}</span></span>
      <span class="av-porte-dates"><span class="sr-only">Semaine ${s.numero}, </span>${fmtCourt(s.debut)} → ${fmtCourt(s.fin)}</span>
      <span class="av-porte-cadeau ${s.cadeau ? '' : 'vide'}">${s.cadeau ? echap(s.cadeau) : 'Cadeau à définir'}</span>
      <span class="av-porte-pied">${t
        ? `<span class="av-porte-gagnant">${ico('cadeau')} ${echap(affiche(t.gagnant.nom))}</span><span class="st ${t.statut}">${LIB_REMISE[t.statut]}</span>`
        : `${ico('clients')} ${pluriel(s.participants.length, 'participant')}`}</span>
    </button>`;
  }

  function blocSemaine(s) {
    const st = statut(s);
    const verrou = !!s.tirage;
    return `
      <div class="av-sem-tete">
        <span class="av-porte-num" aria-hidden="true">${s.numero}</span>
        <div class="av-sem-titre">
          <h2 id="sem-titre">Semaine ${s.numero}</h2>
          <p>Du ${fmtJour(s.debut)} au ${fmtJour(s.fin)} <span class="st ${st}">${LIB_STATUT[st]}</span>
            ${verrou ? '' : `<button type="button" class="av-btn discret mini" data-action="dates" aria-expanded="${datesOuvertes}">${ico('crayon')} Dates</button>`}</p>
        </div>
        <button type="button" class="av-btn discret mini" data-action="imprimer">${ico('imprimer')} Imprimer</button>
      </div>
      ${datesOuvertes && !verrou ? `
        <div class="av-dates-edition">
          <div><label for="date-debut">Du</label><input type="date" id="date-debut" value="${s.debut}"></div>
          <div><label for="date-fin">Au</label><input type="date" id="date-fin" value="${s.fin}"></div>
          <button type="button" class="av-btn principal mini" data-action="dates-ok">Enregistrer</button>
          <button type="button" class="av-btn discret mini" data-action="dates">Annuler</button>
        </div>` : ''}
      <div>
        <label for="cadeau">Cadeau de la semaine</label>
        <div class="av-champ-cadeau">
          <input type="text" id="cadeau" maxlength="160" value="${echap(s.cadeau)}" placeholder="Ex. : un growler de 2 L de bière de Noël" autocomplete="off">
          <span class="av-enregistre" id="cadeau-ok" aria-live="polite"></span>
        </div>
      </div>
      ${s.tirage ? blocGagnant(s) : blocTirage(s, st)}
      ${blocHistorique(s)}`;
  }

  function blocTirage(s, st) {
    const { eligibles, chances, dejaGagnants, exclus } = eligibilite(s);
    const avert = [];
    if (!s.participants.length) avert.push('Aucun participant : importez l’export de la carte de fidélité ou ajoutez des clients à la main.');
    else if (st === 'a_venir') avert.push('Cette semaine n’a pas encore commencé.');
    else if (st === 'en_cours') avert.push(`La semaine n’est pas terminée : les clients qui viendront d’ici au ${fmtJour(s.fin)} ne seraient pas dans le tirage.`);
    if (!s.cadeau) avert.push('Aucun cadeau renseigné pour cette semaine.');
    const horsTirage = [
      dejaGagnants ? `${pluriel(dejaGagnants, 'déjà gagnant')} d’une autre semaine` : '',
      exclus ? pluriel(exclus, 'exclu') : '',
    ].filter(Boolean).join(' et ');
    return `
      <div class="av-tirage">
        <div class="chiffres">
          <div class="av-chiffre"><b>${s.participants.length}</b><span>${s.participants.length > 1 ? 'participants' : 'participant'}</span></div>
          <div class="av-chiffre"><b>${eligibles.length}</b><span>dans le tirage</span></div>
          ${etat.reglages.chances === 'passage' ? `<div class="av-chiffre"><b>${chances}</b><span>chances (passages)</span></div>` : ''}
        </div>
        ${horsTirage ? `<p class="aide">Hors tirage : ${horsTirage}.</p>` : ''}
        ${avert.map(a => `<p class="av-avert">${ico('alerte')}<span>${a}</span></p>`).join('')}
        <button type="button" class="av-btn principal grand" data-action="tirer" ${eligibles.length ? '' : 'disabled'}>${ico('melanger')} Lancer le tirage</button>
        <p class="aide">Le tirage s’ouvre en plein écran, prêt à être montré au bar ou filmé en story.
          Le gagnant est tiré et enregistré par le serveur : impossible de relancer sans motif.</p>
      </div>`;
  }

  function blocGagnant(s) {
    const t = s.tirage;
    const g = t.gagnant;
    const sms = `Bonjour ${prenomDe(g.nom)} ! Bonne nouvelle : vous avez gagné le cadeau de la semaine ${s.numero} du calendrier de l’Avent du Gué des Moines`
      + `${s.cadeau ? ` (${s.cadeau})` : ''}. Passez le récupérer à la brasserie, on vous attend ! L’équipe du Gué`;
    return `
      <div class="av-gagnant">
        <span class="sur">Tiré au sort · semaine ${s.numero}</span>
        <span class="nom">${echap(g.nom)}</span>
        <div class="infos">
          ${g.tel ? `<a href="tel:${echap(telLien(g.tel))}">${ico('telephone')} ${echap(g.tel)}</a>` : ''}
          ${g.email ? `<a href="mailto:${echap(g.email)}">${ico('mail')} ${echap(g.email)}</a>` : ''}
          ${g.jours?.length ? `<span>Passage${g.jours.length > 1 ? 's' : ''} : ${g.jours.map(fmtJour).join(', ')}</span>` : ''}
          ${!g.tel && !g.email ? '<span>Aucun contact dans la liste : à reconnaître au comptoir.</span>' : ''}
        </div>
        <div class="av-suivi" role="group" aria-label="Suivi du gagnant">
          ${Object.entries(LIB_REMISE).map(([k, l]) => `<button type="button" data-action="remise" data-statut="${k}" aria-pressed="${t.statut === k}">${l}</button>`).join('')}
        </div>
        <input type="text" class="av-note" id="note-remise" maxlength="300" value="${echap(t.note)}" placeholder="Note : prévenu par SMS, passe samedi…" aria-label="Note sur la remise du cadeau">
        <div class="av-actions">
          <button type="button" class="av-btn principal" data-action="revoir">${ico('lecture')} Revoir l’animation</button>
          ${g.tel ? `<a class="av-btn" href="sms:${echap(telLien(g.tel))}?&body=${encodeURIComponent(sms)}">${ico('message')} Prévenir par SMS</a>` : ''}
          <button type="button" class="av-btn" data-action="retirer">${ico('annuler')} Nouveau tirage…</button>
        </div>
        <p class="preuve">Tiré le ${fmtHeure(t.le)} parmi ${pluriel(t.nbEligibles, 'participant')}
          ${t.chances === 'passage' ? ` (${pluriel(t.nbChances, 'chance')})` : ''} · empreinte de la liste ${echap(t.empreinte)}</p>
      </div>`;
  }

  function blocHistorique(s) {
    const h = s.historique ?? [];
    if (!h.length) return '';
    return `<details class="av-histo">
      <summary>${pluriel(h.length, 'tirage annulé', 'tirages annulés')}</summary>
      <ul>${h.map(x => `<li><b>${echap(x.gagnant.nom)}</b> — tiré le ${fmtHeure(x.le)}, annulé le ${fmtHeure(x.annuleLe)} :
        ${echap(x.motifLibelle)}${x.precision ? ` (${echap(x.precision)})` : ''}</li>`).join('')}</ul>
    </details>`;
  }

  function blocParticipants(s) {
    const verrou = !!s.tirage;
    const { autres, exclus } = eligibilite(s);
    const n = s.participants.length;
    const dernier = (s.imports ?? []).at(-1);
    return `
      <div class="av-part-barre">
        <h3 id="part-titre">Participants <small>${pluriel(n, 'personne')}${exclus ? ` · ${pluriel(exclus, 'exclue')}` : ''}</small></h3>
        ${n > 8 ? `<input type="search" id="recherche" placeholder="Rechercher…" value="${echap(filtre)}" aria-label="Rechercher un participant" style="width:min(220px,100%)">` : ''}
        ${verrou ? '' : `<button type="button" class="av-btn mini" data-action="ajout" aria-expanded="${ajoutOuvert}">${ico('plus')} Ajouter à la main</button>`}
        ${!verrou && n ? `<button type="button" class="av-btn mini discret danger" data-action="vider">${ico('corbeille')} Vider</button>` : ''}
      </div>
      ${verrou ? `<p class="carte-soustitre">${ico('check')} Liste figée depuis le tirage du ${fmtHeure(s.tirage.le)}.</p>` : ''}
      ${ajoutOuvert && !verrou ? `
        <form class="av-ajout" id="form-ajout">
          <div><label for="ajout-nom">Prénom et nom</label><input type="text" id="ajout-nom" maxlength="80" required autocomplete="off"></div>
          <div><label for="ajout-contact">Téléphone ou e-mail (facultatif)</label><input type="text" id="ajout-contact" maxlength="120" autocomplete="off"></div>
          <button type="submit" class="av-btn principal">${ico('plus')} Ajouter</button>
        </form>` : ''}
      ${n ? `<div class="av-table-wrap"><table class="av-table">
          <thead><tr><th>Client</th><th>Contact</th><th>Passages</th><th class="act"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody id="corps-participants">${lignesParticipants(s, autres)}</tbody>
        </table></div>`
      : `<div class="av-vide">${ico('clients')}
          <span>Aucun participant pour cette semaine.<br>Importez l’export de la carte de fidélité : chaque passage est rangé dans la bonne semaine.</span>
          ${verrou ? '' : `<span class="av-actions"><button type="button" class="av-btn principal mini" data-action="importer">${ico('importer')} Importer un fichier</button>
          <button type="button" class="av-btn mini" data-action="coller">${ico('coller')} Coller une liste</button></span>`}
        </div>`}
      ${dernier ? `<p class="carte-soustitre">Dernier import : ${echap(dernier.source)} — ${fmtHeure(dernier.le)}, ${pluriel(dernier.ajoutes, 'nouveau participant', 'nouveaux participants')}.</p>` : ''}`;
  }

  function lignesParticipants(s, autres) {
    const q = sansAccent(filtre.trim());
    const liste = s.participants
      .filter(p => !q || sansAccent(`${p.nom} ${p.tel} ${p.email}`).includes(q))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    if (!liste.length) return `<tr><td colspan="4" class="contact">Aucun participant ne correspond à « ${echap(filtre)} ».</td></tr>`;
    const verrou = !!s.tirage;
    return liste.map(p => {
      const gagneAilleurs = autres.get(p.cle);
      const gagnantIci = s.tirage?.gagnant.cle === p.cle;
      return `<tr class="${p.exclu ? 'exclu' : ''}">
        <td><b>${echap(p.nom)}</b>${gagnantIci ? '<span class="tag gagne">gagnant</span>' : ''}${gagneAilleurs ? `<span class="tag gagne">a gagné la semaine ${gagneAilleurs.numero}</span>` : ''}${p.manuel ? '<span class="tag">ajouté à la main</span>' : ''}${p.exclu ? '<span class="tag">exclu</span>' : ''}</td>
        <td class="contact">${[p.tel, p.email].filter(Boolean).map(echap).join(' · ') || '—'}</td>
        <td class="n">${p.passages}${p.jours?.length ? ` <span class="contact">· ${p.jours.map(fmtJourMini).join(', ')}</span>` : ''}</td>
        <td class="act">${verrou ? '' : `
          <button type="button" class="av-btn mini discret" data-action="exclure" data-cle="${echap(p.cle)}">${p.exclu ? 'Réintégrer' : 'Exclure'}</button>
          <button type="button" class="av-btn mini discret danger" data-action="supprimer" data-cle="${echap(p.cle)}" aria-label="Retirer ${echap(p.nom)}">${ico('corbeille')}</button>`}</td>
      </tr>`;
    }).join('');
  }

  const blocRegles = () => `
    <section class="av-regles" aria-labelledby="regles-titre">
      <h2 id="regles-titre">${ico('liste')} Règles du jeu</h2>
      <div class="groupe">
        <span class="groupe-titre">Gagnants</span>
        <label class="option"><input type="checkbox" data-regle="exclureGagnants" ${etat.reglages.exclureGagnants ? 'checked' : ''}>
          <span>Un client ne gagne qu’une fois<small>Les gagnants des autres semaines ne participent plus aux tirages suivants.</small></span></label>
      </div>
      <div class="groupe" role="radiogroup" aria-label="Chances de gagner">
        <span class="groupe-titre">Chances</span>
        <label class="option"><input type="radio" name="chances" value="personne" data-regle="chances" ${etat.reglages.chances === 'personne' ? 'checked' : ''}>
          <span>1 chance par client<small>Venu une ou cinq fois dans la semaine : même chance pour tous.</small></span></label>
        <label class="option"><input type="radio" name="chances" value="passage" data-regle="chances" ${etat.reglages.chances === 'passage' ? 'checked' : ''}>
          <span>1 chance par passage<small>Chaque jour de passage dans la semaine compte pour une chance de plus.</small></span></label>
      </div>
      <p class="carte-soustitre">Les membres de l’équipe s’excluent d’un clic dans la liste des participants ; l’exclusion est conservée aux imports suivants.</p>
    </section>
    <section aria-labelledby="etapes-titre">
      <h2 id="etapes-titre">${ico('horloge')} Chaque semaine</h2>
      <ol class="av-etapes">
        <li><span><b>Exportez</b> les passages (tampons) depuis l’outil de la carte de fidélité, en Excel ou CSV.</span></li>
        <li><span><b>Importez</b> le fichier ici : chaque client est rangé dans la semaine de son passage.</span></li>
        <li><span><b>Lancez le tirage</b> en plein écran, au bar ou en story.</span></li>
        <li><span><b>Prévenez</b> le gagnant (SMS prêt en un clic) et notez la remise du cadeau.</span></li>
      </ol>
    </section>`;

  // =========================================================================
  //  Actions
  // =========================================================================
  async function enregistrerParticipants(s, participants) {
    try {
      remplacer(await api(`/${etat.annee}/semaines/${s.id}/participants`, { methode: 'PUT', corps: { participants } }));
      rendre();
    } catch (e) { toast(e.message, true); }
  }

  $('vue').addEventListener('click', async e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const s = semaineChoisie();
    switch (b.dataset.action) {
      case 'choisir':
        choisie = b.dataset.id; filtre = ''; ajoutOuvert = false; datesOuvertes = false;
        history.replaceState(null, '', `#${choisie}`);
        rendre();
        break;
      case 'importer': $('fichier-import').click(); break;
      case 'coller': ouvrirCollage(); break;
      case 'imprimer': print(); break;
      case 'dates': datesOuvertes = !datesOuvertes; rendre(); break;
      case 'dates-ok': {
        const debut = $('date-debut').value, fin = $('date-fin').value;
        if (!debut || !fin || debut > fin) return toast('La date de fin doit suivre la date de début.', true);
        const chevauche = etat.semaines.find(x => x.id !== s.id && x.debut <= fin && debut <= x.fin);
        if (chevauche && !confirm(`Ces dates chevauchent la semaine ${chevauche.numero}. Les enregistrer quand même ?`)) return;
        try {
          remplacer(await api(`/${etat.annee}/semaines/${s.id}`, { methode: 'PUT', corps: { debut, fin } }));
          datesOuvertes = false; rendre(); toast('Dates enregistrées');
        } catch (err) { toast(err.message, true); }
        break;
      }
      case 'tirer': ouvrirScene(s); break;
      case 'revoir': ouvrirScene(s, { rejouer: true }); break;
      case 'retirer': ouvrirRetirage(s); break;
      case 'remise':
        try {
          remplacer(await api(`/${etat.annee}/semaines/${s.id}/remise`, { methode: 'PUT', corps: { statut: b.dataset.statut } }));
          rendre();
        } catch (err) { toast(err.message, true); }
        break;
      case 'ajout': ajoutOuvert = !ajoutOuvert; rendre(); if (ajoutOuvert) $('ajout-nom')?.focus(); break;
      case 'vider':
        if (!confirm(`Retirer les ${s.participants.length} participants de la semaine ${s.numero} ?`)) return;
        enregistrerParticipants(s, []);
        break;
      case 'exclure':
        enregistrerParticipants(s, s.participants.map(p => p.cle === b.dataset.cle ? { ...p, exclu: !p.exclu } : p));
        break;
      case 'supprimer':
        enregistrerParticipants(s, s.participants.filter(p => p.cle !== b.dataset.cle));
        break;
    }
  });

  $('vue').addEventListener('change', async e => {
    const s = semaineChoisie();
    const el = e.target;
    if (el.id === 'cadeau') {
      try {
        remplacer(await api(`/${etat.annee}/semaines/${s.id}`, { methode: 'PUT', corps: { cadeau: el.value } }));
        // Pas de nouveau rendu complet : l'utilisateur est peut-être déjà
        // dans un autre champ. On rafraîchit seulement la porte.
        const p = document.querySelector(`.av-porte[data-id="${s.id}"]`);
        if (p) p.outerHTML = porte(semaineChoisie());
        const ok = $('cadeau-ok'); if (ok) { ok.textContent = 'Enregistré'; setTimeout(() => { ok.textContent = ''; }, 2500); }
      } catch (err) { toast(err.message, true); }
    } else if (el.id === 'note-remise') {
      try { remplacer(await api(`/${etat.annee}/semaines/${s.id}/remise`, { methode: 'PUT', corps: { note: el.value } })); toast('Note enregistrée'); }
      catch (err) { toast(err.message, true); }
    } else if (el.dataset.regle) {
      const corps = el.dataset.regle === 'exclureGagnants' ? { exclureGagnants: el.checked } : { chances: el.value };
      try { etat.reglages = await api(`/${etat.annee}/reglages`, { methode: 'PUT', corps }); rendre(); toast('Règles enregistrées'); }
      catch (err) { toast(err.message, true); rendre(); }
    }
  });

  $('vue').addEventListener('input', e => {
    if (e.target.id !== 'recherche') return;
    filtre = e.target.value;
    const s = semaineChoisie();
    const corps = $('corps-participants');
    if (corps) corps.innerHTML = lignesParticipants(s, eligibilite(s).autres);
  });

  $('vue').addEventListener('submit', e => {
    if (e.target.id !== 'form-ajout') return;
    e.preventDefault();
    const s = semaineChoisie();
    const nom = $('ajout-nom').value.trim();
    const contact = $('ajout-contact').value.trim();
    if (!nom) return;
    const email = /@/.test(contact) ? contact.toLowerCase() : '';
    const tel = email ? '' : formaterTel(contact);
    const p = { nom, tel, email, jours: [], passages: 1, manuel: true, exclu: false };
    p.cle = clePersonne(p);
    if (s.participants.some(x => x.cle === p.cle)) return toast(`${nom} est déjà dans la liste.`, true);
    ajoutOuvert = true;
    enregistrerParticipants(s, [...s.participants, p]).then(() => $('ajout-nom')?.focus());
  });

  // =========================================================================
  //  Import : export de la carte de fidélité, CSV, liste collée
  // =========================================================================
  // Le but : lire juste dans la plupart des cas, sans réglage. Les colonnes
  // sont repérées par leur en-tête (FR ou EN), sinon par leur contenu. La
  // colonne de date reste modifiable dans l'aperçu : c'est elle qui décide
  // dans quelle semaine tombe chaque passage.
  const RE_MAIL = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}/i;
  const RE_TEL = /(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/;
  const MOIS_NOMS = [['jan'], ['fev', 'feb'], ['mar'], ['avr', 'apr'], ['mai', 'may'], ['juin', 'jun'], ['juil', 'jul'], ['aou', 'aug'], ['sep'], ['oct'], ['nov'], ['dec']];
  const moisDe = m => { const i = MOIS_NOMS.findIndex(l => l.some(x => m.startsWith(x))); return i >= 0 ? i + 1 : 0; };
  function valide(a, m, j) {
    if (a < 2000 || a > 2100 || m < 1 || m > 12 || j < 1 || j > 31) return null;
    const d = new Date(a, m - 1, j, 12);
    return d.getMonth() === m - 1 ? jourLocal(d) : null;
  }
  // ordre : 'jm' (05/12 = 5 décembre, par défaut) ou 'mj' (export à
  // l'américaine, 12/05 = 5 décembre), décidé pour toute la colonne.
  const RE_JMA = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[\sT,].*)?$/;
  function jourDe(v, ordre = 'jm') {
    if (v instanceof Date) return isNaN(v) ? null : jourLocal(new Date(v.getTime() + 30_000));
    const s = String(v ?? '').trim();
    if (!s || s.length > 40) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/);
    if (m) {
      // Heure avec fuseau (« …T23:30:00Z ») : le jour qui compte est celui de Paris.
      if (/^[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(m[4])) {
        const d = new Date(s.replace(' ', 'T'));
        if (!isNaN(d)) return jourParis(d);
      }
      return valide(+m[1], +m[2], +m[3]);
    }
    m = s.match(RE_JMA);
    if (m) {
      let j = +m[1], mo = +m[2];
      const a = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if ((ordre === 'mj' && j <= 12) || (mo > 12 && j <= 12)) [j, mo] = [mo, j];
      return valide(a, mo, j);
    }
    const t = sansAccent(s);
    m = t.match(/^(?:[a-z]+\.?,?\s+)?(\d{1,2})(?:er)?\s+([a-z]+)\.?,?\s+(\d{4})/);
    if (m && moisDe(m[2])) return valide(+m[3], moisDe(m[2]), +m[1]);
    m = t.match(/^(?:[a-z]+\.?,?\s+)?([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && moisDe(m[1])) return valide(+m[3], moisDe(m[1]), +m[2]);
    return null;
  }
  const texte = v => v instanceof Date ? '' : String(v ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const estMail = v => RE_MAIL.test(texte(v)) && texte(v).length < 120;
  const estTel = v => {
    const s = texte(v);
    if (!/^[\d\s+().\-]{9,20}$/.test(s)) return false;
    const d = s.replace(/\D/g, '');
    return d.length >= 9 && d.length <= 13;
  };
  const estNom = v => {
    const s = texte(v);
    return s.length >= 2 && s.length <= 60 && /^\p{L}[\p{L}\s'’.\-]*$/u.test(s);
  };

  // Type d'une colonne d'après son en-tête
  function typeEntete(c) {
    const s = sansAccent(texte(c));
    if (!s || s.length > 50) return null;
    if (/naissance|anniversaire|birth/.test(s)) return 'ignorer';
    if (/\bid\b|identifiant|^n[°o]\b|numero de (carte|client)|code|qr|statut|status|solde|points?\b|niveau|tier/.test(s)) return 'ignorer';
    if (/^(e-?mail|courriel|adresse (e-?)?mail|mail)\b/.test(s)) return 'email';
    if (/^(tel|phone|portable|mobile|gsm|cellulaire|numero de tel|numero mobile|telephone)/.test(s)) return 'tel';
    if (/^(nom complet|full ?name|nom et prenom|prenom et nom|prenom nom|nom prenom|client|customer|titulaire|porteur|membre|member|name|identite|participant|utilisateur|user|holder)\b/.test(s)) return 'complet';
    if (/^(prenom|first ?name|firstname|given ?name)\b/.test(s)) return 'prenom';
    if (/^(nom de famille|last ?name|lastname|surname|family ?name)\b/.test(s)) return 'famille';
    if (/^nom\b/.test(s)) return 'nom';
    if (/expir|modifi|updated|mise a jour/.test(s)) return 'ignorer';
    if (/tampon|stamp|transaction|scan|passage|horodatage|timestamp|validation|operation|evenement|event|recompense|reward|visit|visite|consommation|achat|purchase|activit|dernier|derniere|last/.test(s)) return 'date-forte';
    if (/inscri|creation|cree|created|signup|sign up|enregistr|registration|adhesion|join/.test(s)) return 'date-faible';
    if (/^(date|jour|le|quand|heure|time|when)\b|date$/.test(s)) return 'date';
    return null;
  }
  const RANG_DATE = { 'date-forte': 4, date: 3, contenu: 2, 'date-faible': 1 };
  // Une colonne où une valeur commence par 13 à 31 est forcément jour/mois ;
  // une où la deuxième valeur dépasse 12, forcément mois/jour.
  function ordreColonne(valeurs) {
    let jm = false, mj = false;
    for (const v of valeurs) {
      const m = typeof v === 'string' && v.trim().match(RE_JMA);
      if (!m) continue;
      if (+m[1] > 12) jm = true;
      if (+m[2] > 12) mj = true;
    }
    return mj && !jm ? 'mj' : 'jm';
  }

  function analyser(lignesBrutes) {
    const lignes = lignesBrutes
      .map(r => (r ?? []).map(c => c instanceof Date ? c : String(c ?? '').replace(/ /g, ' ').trim()))
      .filter(r => r.some(c => c instanceof Date || c));
    if (!lignes.length) throw new Error('aucune ligne lisible');
    const nbCol = Math.max(...lignes.map(r => r.length));

    // Une seule colonne : liste collée (« Jean Dupont 06… »), on découpe chaque ligne.
    if (nbCol === 1) {
      const visites = lignes.map(([c]) => {
        const s = texte(c);
        const email = (s.match(RE_MAIL)?.[0] ?? '').toLowerCase();
        const tel = s.match(RE_TEL)?.[0] ?? '';
        const dm = s.match(/\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/);
        const nom = s.replace(email, ' ').replace(tel, ' ').replace(dm?.[0] ?? '', ' ')
          .replace(/[;,|\t]+/g, ' ').replace(/\s[-–—:]+\s/g, ' ').replace(/^[\s\-–—•*·\d.)]+/, '').replace(/[\s\-–—:]+$/, '').replace(/\s+/g, ' ').trim();
        const t = formaterTel(tel);
        return { nom: nom || (email ? email.split('@')[0] : t ? `Client ${t}` : ''), tel: t, email, brut: [dm?.[0] ?? ''] };
      }).filter(v => v.nom && !/^(nom|pr[ée]nom|client|liste)\b/i.test(v.nom));
      const ordre = ordreColonne(visites.map(v => v.brut[0]));
      const avecDate = visites.filter(v => jourDe(v.brut[0], ordre)).length;
      return finirLecture(visites, avecDate ? [{ j: 0, libelle: 'date dans la ligne', rang: 2, ordre }] : [], ['nom', 'contact'], lignes.length);
    }

    // Ligne d'en-tête : celle qui contient le plus d'intitulés reconnus.
    let h = -1, meilleur = 0;
    for (let i = 0; i < Math.min(10, lignes.length); i++) {
      const n = lignes[i].filter(c => typeof c === 'string' && typeEntete(c) && typeEntete(c) !== 'ignorer').length;
      if (n > meilleur) { meilleur = n; h = i; }
    }
    const entetes = h >= 0 ? lignes[h].map(texte) : [];
    const donnees = lignes.slice(h + 1);
    const cols = { prenom: -1, famille: -1, nom: -1, complet: -1, tel: -1, email: -1 };
    const dates = [];
    const nomsContenu = [];
    for (let j = 0; j < nbCol; j++) {
      const valeurs = donnees.map(r => r[j]).filter(v => v instanceof Date || v);
      if (!valeurs.length) continue;
      const part = f => valeurs.filter(f).length / valeurs.length;
      const t = typeEntete(entetes[j]);
      if (t === 'ignorer') continue;
      const libelle = entetes[j] || `colonne ${j + 1}`;
      const ordre = ordreColonne(valeurs);
      const estDate = v => !!jourDe(v, ordre);
      if (t?.startsWith('date')) { if (part(estDate) >= 0.5) dates.push({ j, libelle, rang: RANG_DATE[t], ordre }); continue; }
      if (t === 'email' || t === 'tel') { if (cols[t] < 0) cols[t] = j; continue; }
      if (t && cols[t] < 0 && part(estNom) >= 0.5) { cols[t] = j; continue; }
      // Pas d'en-tête parlant : on regarde le contenu.
      if (cols.email < 0 && part(estMail) >= 0.5) cols.email = j;
      else if (cols.tel < 0 && part(estTel) >= 0.5) cols.tel = j;
      else if (part(estDate) >= 0.6) dates.push({ j, libelle, rang: RANG_DATE.contenu, ordre });
      else if (part(estNom) >= 0.6) nomsContenu.push(j);
    }
    // Nom : prénom + nom, sinon nom complet, sinon colonnes de texte repérées
    // au contenu (deux colonnes voisines = prénom puis nom).
    let colsNom;
    if (cols.prenom >= 0 && (cols.famille >= 0 || cols.nom >= 0)) colsNom = [cols.prenom, cols.famille >= 0 ? cols.famille : cols.nom];
    else if (cols.complet >= 0) colsNom = [cols.complet];
    else if (cols.nom >= 0 || cols.famille >= 0 || cols.prenom >= 0) colsNom = [cols.prenom, cols.nom, cols.famille].filter(j => j >= 0);
    else if (nomsContenu.length >= 2 && nomsContenu[1] === nomsContenu[0] + 1 && h < 0) colsNom = nomsContenu.slice(0, 2);
    else colsNom = nomsContenu.slice(0, 1);

    const visites = donnees.map(r => {
      const email = (texte(r[cols.email]).match(RE_MAIL)?.[0] ?? '').toLowerCase();
      const tel = cols.tel >= 0 ? formaterTel(texte(r[cols.tel])) : '';
      let nom = colsNom.map(j => texte(r[j])).filter(Boolean).join(' ');
      if (!nom && email) nom = email.split('@')[0].replace(/[._\d]+/g, ' ').trim() || email;
      if (!nom && tel) nom = `Client ${tel}`;
      return { nom, tel, email, brut: r };
    }).filter(v => v.nom);

    const reconnues = [
      colsNom.length ? `nom (${colsNom.map(j => entetes[j] || `colonne ${j + 1}`).join(' + ')})` : '',
      cols.tel >= 0 ? `téléphone (${entetes[cols.tel] || `colonne ${cols.tel + 1}`})` : '',
      cols.email >= 0 ? `e-mail (${entetes[cols.email] || `colonne ${cols.email + 1}`})` : '',
    ].filter(Boolean);
    return finirLecture(visites, dates, reconnues, donnees.length);
  }

  function finirLecture(visites, dates, reconnues, nbLignes) {
    if (!visites.length) throw new Error('aucun client reconnu (il faut au moins un nom, un téléphone ou un e-mail par ligne)');
    dates.sort((a, b) => b.rang - a.rang || a.j - b.j);
    return { visites, dates, reconnues, nbLignes };
  }

  // Range chaque passage dans sa semaine. Sans colonne de date, toute la
  // liste va dans la semaine choisie.
  function repartir(lecture, colDate, cible) {
    const ordre = lecture.dates.find(d => d.j === colDate)?.ordre ?? 'jm';
    const parSemaine = new Map(etat.semaines.map(s => [s.id, new Map()]));
    let hors = 0, sansDate = 0;
    for (const v of lecture.visites) {
      const cle = clePersonne(v);
      if (!cle) continue;
      let sid = cible, jour = null;
      if (colDate >= 0) {
        jour = jourDe(v.brut[colDate], ordre);
        if (!jour) { sansDate++; continue; }
        const s = etat.semaines.find(x => x.debut <= jour && jour <= x.fin);
        if (!s) { hors++; continue; }
        sid = s.id;
      }
      const m = parSemaine.get(sid);
      const p = m.get(cle) ?? { cle, nom: v.nom, tel: v.tel, email: v.email, jours: new Set() };
      if (jour) p.jours.add(jour);
      p.tel ||= v.tel; p.email ||= v.email;
      if (/^client /i.test(p.nom) && !/^client /i.test(v.nom)) p.nom = v.nom;
      m.set(cle, p);
    }
    return { parSemaine, hors, sansDate };
  }

  function chargerScript(src) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error('lecteur Excel inaccessible (connexion ?)'));
      document.head.appendChild(s);
    });
  }
  function lireCSV(t) {
    t = t.replace(/^﻿/, '');
    const debut = t.split(/\r?\n/).slice(0, 6).join('\n');
    const compte = c => debut.split(c).length - 1;
    const sep = ['\t', ';', ','].sort((a, b) => compte(b) - compte(a))[0];
    if (!compte(sep)) return t.split(/\r?\n/).filter(l => l.trim()).map(l => [l.trim()]);
    const lignes = [];
    let ligneCourante = [], champ = '', guillemets = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (guillemets) {
        if (c === '"') { if (t[i + 1] === '"') { champ += '"'; i++; } else guillemets = false; }
        else champ += c;
      } else if (c === '"' && !champ.trim()) { guillemets = true; champ = ''; }
      else if (c === sep) { ligneCourante.push(champ); champ = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && t[i + 1] === '\n') i++;
        ligneCourante.push(champ); lignes.push(ligneCourante); ligneCourante = []; champ = '';
      } else champ += c;
    }
    if (champ || ligneCourante.length) { ligneCourante.push(champ); lignes.push(ligneCourante); }
    return lignes;
  }
  async function lireFichier(f) {
    const nom = f.name.toLowerCase();
    if (/\.(xlsx|xlsm|xls|ods)$/.test(nom)) {
      if (!window.XLSX) await chargerScript(CDN_XLSX);
      // cellDates : les dates arrivent en vraies dates, sans passer par le
      // format d'affichage d'Excel (souvent à l'américaine).
      const classeur = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const feuilles = classeur.SheetNames.map(n => XLSX.utils.sheet_to_json(classeur.Sheets[n], { header: 1, raw: true, defval: '' }));
      return feuilles.sort((a, b) => b.length - a.length)[0] ?? [];
    }
    const octets = await f.arrayBuffer();
    let t = new TextDecoder('utf-8').decode(octets);
    if (t.includes('�')) t = new TextDecoder('windows-1252').decode(octets);   // export Excel « CSV (séparateur ; ) »
    return lireCSV(t);
  }

  $('fichier-import').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { ouvrirApercu(analyser(await lireFichier(f)), f.name); }
    catch (err) { toast(`Lecture impossible : ${err.message}`, true); }
  });

  function ouvrirCollage() {
    const dlg = $('dlg-import');
    dlg.innerHTML = `
      <div class="dlg">
        <div class="dlg-tete"><div><h2 id="imp-titre">Coller une liste</h2>
          <p>Collez des lignes copiées depuis Excel, un export, un mail… Un client par ligne : nom, téléphone ou e-mail, et la date de passage si vous l’avez.</p></div>
          <button type="button" class="av-btn discret mini" data-fermer aria-label="Fermer">${ico('croix')}</button></div>
        <div class="dlg-corps">
          <textarea id="colle-texte" rows="10" placeholder="Prénom;Nom;Téléphone;Date&#10;Luccio;Martin;06 12 34 56 78;02/12/2026&#10;…"></textarea>
        </div>
        <div class="dlg-pied"><button type="button" class="av-btn" data-fermer>Annuler</button>
          <button type="button" class="av-btn principal" id="colle-ok">Lire la liste</button></div>
      </div>`;
    dlg.querySelectorAll('[data-fermer]').forEach(b => b.onclick = () => dlg.close());
    $('colle-ok').onclick = () => {
      const t = $('colle-texte').value;
      if (!t.trim()) return $('colle-texte').focus();
      try { ouvrirApercu(analyser(lireCSV(t)), 'Liste collée'); }
      catch (err) { toast(`Lecture impossible : ${err.message}`, true); }
    };
    if (!dlg.open) dlg.showModal();
    $('colle-texte').focus();
  }

  function ouvrirApercu(lecture, source) {
    const dlg = $('dlg-import');
    let colDate = lecture.dates[0]?.j ?? -1;
    const cibleDefaut = semaineChoisie().tirage ? (etat.semaines.find(s => !s.tirage)?.id ?? choisie) : choisie;
    let cible = cibleDefaut;

    const dessiner = () => {
      const rep = repartir(lecture, colDate, cible);
      let total = 0;
      const lignesSemaines = etat.semaines.map(s => {
        const m = rep.parSemaine.get(s.id);
        if (!m.size) return '';
        const connus = new Set(s.participants.map(p => p.cle));
        const nouveaux = [...m.keys()].filter(k => !connus.has(k)).length;
        if (!s.tirage) total += m.size;
        return `<div class="${s.tirage ? 'ignore' : ''}"><span class="num">${s.numero}</span>
          <span class="quoi">Semaine ${s.numero}<small>${fmtCourt(s.debut)} → ${fmtCourt(s.fin)}</small></span>
          <span class="combien">${s.tirage ? 'déjà tirée, ignorée' : `${pluriel(m.size, 'personne')} · ${pluriel(nouveaux, 'nouvelle')}`}</span></div>`;
      }).join('');
      const notes = [
        rep.hors ? `${pluriel(rep.hors, 'passage')} hors des semaines du calendrier, ${rep.hors > 1 ? 'ignorés' : 'ignoré'}.` : '',
        rep.sansDate ? `${pluriel(rep.sansDate, 'ligne')} sans date lisible, ${rep.sansDate > 1 ? 'ignorées' : 'ignorée'}.` : '',
      ].filter(Boolean);
      const exemples = lecture.visites.slice(0, 6);
      const ordre = lecture.dates.find(d => d.j === colDate)?.ordre ?? 'jm';
      const jourEx = v => jourDe(v.brut[colDate], ordre);
      dlg.innerHTML = `
        <div class="dlg">
          <div class="dlg-tete"><div><h2 id="imp-titre">Importer des participants</h2>
            <p>${echap(source)} · ${pluriel(lecture.nbLignes, 'ligne lue', 'lignes lues')}</p></div>
            <button type="button" class="av-btn discret mini" data-fermer aria-label="Fermer">${ico('croix')}</button></div>
          <div class="dlg-corps">
            <div class="lecture-info">
              <span>Colonnes reconnues : <b>${echap(lecture.reconnues.join(', ') || 'nom')}</b></span>
              <span class="ligne-choix"><label for="imp-date" style="margin:0">Date de passage :</label>
                <span class="select-enveloppe"><select id="imp-date">
                  ${lecture.dates.map(d => `<option value="${d.j}" ${d.j === colDate ? 'selected' : ''}>${echap(d.libelle)}</option>`).join('')}
                  <option value="-1" ${colDate < 0 ? 'selected' : ''}>Aucune : tout mettre dans une semaine</option>
                </select></span></span>
              ${colDate < 0 ? `<span class="ligne-choix"><label for="imp-cible" style="margin:0">Semaine :</label>
                <span class="select-enveloppe"><select id="imp-cible">${etat.semaines.map(s => `<option value="${s.id}" ${s.id === cible ? 'selected' : ''} ${s.tirage ? 'disabled' : ''}>
                  Semaine ${s.numero} (${fmtCourt(s.debut)} → ${fmtCourt(s.fin)})${s.tirage ? ' — tirée' : ''}</option>`).join('')}</select></span></span>
                <span>Sans date, chaque personne compte pour un passage.</span>` : ''}
              ${!lecture.dates.length ? '<span>Aucune colonne de date trouvée dans ce fichier.</span>' : ''}
            </div>
            ${lignesSemaines ? `<div class="repartition">${lignesSemaines}</div>` : '<p class="av-avert">Aucun passage ne tombe dans les semaines du calendrier. Vérifiez la colonne de date ou les dates des semaines.</p>'}
            ${notes.map(n => `<p class="carte-soustitre">${n}</p>`).join('')}
            <details><summary class="carte-soustitre" style="cursor:pointer">Vérifier la lecture des premières lignes</summary>
              <table class="apercu-mini"><thead><tr><th>Nom</th><th>Affiché au tirage</th><th>Contact</th><th>Date</th></tr></thead><tbody>
              ${exemples.map(v => `<tr><td>${echap(v.nom)}</td><td>${echap(affiche(v.nom))}</td><td>${echap([v.tel, v.email].filter(Boolean).join(' · ') || '—')}</td>
                <td>${colDate >= 0 ? (jourEx(v) ? fmtJour(jourEx(v)) : '?') : '—'}</td></tr>`).join('')}
              </tbody></table></details>
          </div>
          <div class="dlg-pied"><span class="info">${pluriel(total, 'personne')} à ranger</span>
            <button type="button" class="av-btn" data-fermer>Annuler</button>
            <button type="button" class="av-btn principal" id="imp-ok" ${total ? '' : 'disabled'}>${ico('check')} Ajouter au calendrier</button></div>
        </div>`;
      dlg.querySelectorAll('[data-fermer]').forEach(b => b.onclick = () => dlg.close());
      $('imp-date').onchange = e => { colDate = Number(e.target.value); dessiner(); };
      if ($('imp-cible')) $('imp-cible').onchange = e => { cible = e.target.value; dessiner(); };
      $('imp-ok').onclick = async () => {
        $('imp-ok').disabled = true;
        $('imp-ok').innerHTML = '<span class="loader"></span> Enregistrement…';
        try {
          const bilan = await appliquerImport(rep, source);
          dlg.close();
          const premiere = etat.semaines.find(s => rep.parSemaine.get(s.id)?.size && !s.tirage);
          if (premiere && !rep.parSemaine.get(choisie)?.size) choisie = premiere.id;
          rendre();
          toast(`Import terminé : ${pluriel(bilan.ajoutes, 'nouveau participant', 'nouveaux participants')}, ${pluriel(bilan.semaines, 'semaine')} ${bilan.semaines > 1 ? 'mises' : 'mise'} à jour.`);
        } catch (err) {
          toast(err.message, true);
          dessiner();
        }
      };
    };
    dessiner();
    if (!dlg.open) dlg.showModal();
  }

  async function appliquerImport(rep, source) {
    let ajoutes = 0, semaines = 0;
    for (const s of etat.semaines) {
      const m = rep.parSemaine.get(s.id);
      if (!m?.size || s.tirage) continue;
      const liste = new Map(s.participants.map(p => [p.cle, { ...p, jours: [...(p.jours ?? [])] }]));
      let nouveaux = 0;
      for (const p of m.values()) {
        const e = liste.get(p.cle);
        if (e) {
          // Réimporter le même fichier ne double rien : les jours s'unissent.
          e.jours = [...new Set([...e.jours, ...p.jours])].sort();
          e.passages = Math.max(e.passages, e.jours.length, 1);
          e.tel ||= p.tel; e.email ||= p.email;
        } else {
          liste.set(p.cle, { cle: p.cle, nom: p.nom, tel: p.tel, email: p.email, jours: [...p.jours].sort(),
            passages: Math.max(1, p.jours.size), manuel: false, exclu: false });
          nouveaux++;
        }
      }
      remplacer(await api(`/${etat.annee}/semaines/${s.id}/participants`, {
        methode: 'PUT', corps: { participants: [...liste.values()], import: { source, ajoutes: nouveaux } },
      }));
      ajoutes += nouveaux; semaines++;
    }
    return { ajoutes, semaines };
  }

  // =========================================================================
  //  Nouveau tirage (gagnant injoignable…)
  // =========================================================================
  function ouvrirRetirage(s) {
    const dlg = $('dlg-petit');
    const restants = eligibilite(s, { retirage: true }).eligibles.length;
    dlg.innerHTML = `
      <form method="dialog" class="dlg" id="form-retirage">
        <div class="dlg-tete"><div><h2>Nouveau tirage — semaine ${s.numero}</h2>
          <p>${echap(s.tirage.gagnant.nom)} reste dans l’historique de la semaine et ne pourra pas être tiré à nouveau.
          ${pluriel(restants, 'participant')} dans ce nouveau tirage.</p></div></div>
        <div class="dlg-corps">
          <fieldset class="motifs" style="border:0"><legend class="carte-soustitre" style="margin-bottom:6px">Pourquoi refaire le tirage ?</legend>
            ${Object.entries(etat.motifs).map(([k, l]) => `<label><input type="radio" name="motif" value="${k}" required> ${echap(l)}</label>`).join('')}
          </fieldset>
          <div><label for="retirage-precision">Précision (facultatif)</label>
            <input type="text" id="retirage-precision" maxlength="200" placeholder="Ex. : 3 appels et 1 SMS sans réponse"></div>
        </div>
        <div class="dlg-pied"><button type="button" class="av-btn" id="retirage-annuler">Annuler</button>
          <button type="submit" class="av-btn principal" ${restants ? '' : 'disabled'}>${ico('melanger')} Ouvrir le nouveau tirage</button></div>
      </form>`;
    $('retirage-annuler').onclick = () => dlg.close();
    $('form-retirage').onsubmit = e => {
      e.preventDefault();
      const motif = new FormData(e.target).get('motif');
      if (!motif) return;
      const precision = $('retirage-precision').value;
      dlg.close();
      ouvrirScene(s, { motif, precision });
    };
    dlg.showModal();
  }

  // =========================================================================
  //  La scène du tirage : plein écran, aux couleurs du Gué
  // =========================================================================
  let enCours = false;
  let minuteurs = [];
  const arreterMinuteurs = () => { minuteurs.forEach(clearInterval); minuteurs = []; };

  function ouvrirScene(s, { motif = null, precision = '', rejouer = false } = {}) {
    const dlg = $('dlg-scene');
    const pool = rejouer ? s.participants.filter(p => !p.exclu) : eligibilite(s, { retirage: !!motif }).eligibles;
    const noms = pool.map(p => affiche(p.nom));
    if (!noms.length) return toast('Aucun participant dans le tirage.', true);
    const n = pool.length;
    dlg.innerHTML = `
      <div class="av-scene-fond"></div>
      <canvas class="av-confettis" id="sc-confettis" aria-hidden="true"></canvas>
      <div class="av-scene-barre">
        ${document.fullscreenEnabled ? `<button type="button" id="sc-plein" aria-label="Plein écran">${ico('plein_ecran')}</button>` : ''}
        <button type="button" id="sc-fermer" aria-label="Fermer">${ico('croix')}</button>
      </div>
      <div class="av-scene-contenu">
        <img class="av-scene-logo" src="logo.png" alt="Le Gué des Moines">
        <span class="av-pilule">Calendrier de l’Avent du Gué</span>
        <h2 class="av-scene-titre">Semaine ${s.numero}</h2>
        ${s.cadeau ? `<p class="av-scene-cadeau">À gagner : ${echap(s.cadeau)}</p>` : ''}
        <div class="av-rouleau" id="sc-rouleau"><span class="av-rouleau-nom" id="sc-nom" aria-live="off">${echap(noms[0])}</span></div>
        <p class="av-scene-info" id="sc-info">${rejouer
          ? `Tirage du ${fmtHeure(s.tirage.le)} parmi ${pluriel(s.tirage.nbEligibles, 'client fidèle', 'clients fidèles')}`
          : `${pluriel(n, 'client fidèle', 'clients fidèles')} dans le tirage${motif ? ' · nouveau tirage' : ''}`}</p>
        <div id="sc-bas"><button type="button" class="av-scene-go" id="sc-go">${ico('melanger')} Tirer au sort</button></div>
      </div>
      <p class="av-scene-pied">L’abus d’alcool est dangereux pour la santé, à consommer avec modération.</p>`;

    const el = $('sc-nom');
    const rouleau = $('sc-rouleau');
    let dernier = -1;
    const indices = noms.map((_, i) => i);
    // Nom au hasard (affichage seulement), jamais deux fois de suite, et
    // jamais le gagnant pendant le ralentissement : il n'apparaît qu'à la fin.
    const auHasard = (sauf = null) => {
      let choix = indices.filter(i => i !== dernier && noms[i] !== sauf);
      if (!choix.length) choix = indices.filter(i => noms[i] !== sauf);
      if (!choix.length) return noms[0];
      dernier = choix[Math.floor(Math.random() * choix.length)];
      return noms[dernier];
    };
    const montrer = (nom, duree) => {
      el.textContent = nom;
      el.classList.remove('defile');
      void el.offsetWidth;
      el.style.setProperty('--duree', `${Math.round(duree)}ms`);
      el.classList.add('defile');
    };
    const tourner = intervalle => {
      arreterMinuteurs();
      if (MOINS_ANIM) { el.textContent = '…'; return; }
      minuteurs.push(setInterval(() => montrer(auHasard(), intervalle), intervalle));
    };

    tourner(650);   // défilement lent en attendant : l'écran vit pendant qu'on cadre la vidéo

    $('sc-fermer').onclick = () => dlg.close();
    if ($('sc-plein')) $('sc-plein').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
    };
    dlg.oncancel = e => { if (enCours) e.preventDefault(); };
    dlg.onclose = () => {
      arreterMinuteurs();
      enCours = false;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      dlg.innerHTML = '';
      rendre();
    };

    $('sc-go').onclick = async () => {
      enCours = true;
      $('sc-bas').innerHTML = '';
      $('sc-fermer').hidden = true;
      tourner(70);
      const debut = performance.now();
      let sem;
      try {
        sem = rejouer ? s : await api(`/${etat.annee}/semaines/${s.id}/tirage`, {
          methode: 'POST', corps: motif ? { motif, precision } : {},
        });
      } catch (err) {
        arreterMinuteurs();
        enCours = false;
        $('sc-fermer').hidden = false;
        el.textContent = '—';
        $('sc-bas').innerHTML = `<p class="av-scene-erreur">${echap(err.message)}</p>`;
        return;
      }
      remplacer(sem);                       // le résultat est déjà enregistré
      const gagnant = affiche(sem.tirage.gagnant.nom);
      if (!MOINS_ANIM) {
        await pause(Math.max(0, 2400 - (performance.now() - debut)));
        arreterMinuteurs();
        // Ralentissement progressif, façon roue de loterie
        let d = 80;
        for (let i = 0; i < 15; i++) {
          d = Math.min(d * 1.18, 560);
          montrer(auHasard(gagnant), Math.min(d, 260));
          await pause(d);
        }
      }
      arreterMinuteurs();
      el.classList.remove('defile');
      el.textContent = gagnant;
      rouleau.classList.add('gagne');
      $('sc-info').textContent = `Tiré au sort parmi ${pluriel(sem.tirage.nbEligibles, 'client fidèle', 'clients fidèles')}`;
      $('sc-bas').innerHTML = `<p class="av-scene-bravo">Félicitations !</p>`;
      $('sc-fermer').hidden = false;
      enCours = false;
      if (!MOINS_ANIM) confettis($('sc-confettis'));
    };

    dlg.showModal();
    $('sc-go').focus();
  }

  // Confettis aux couleurs de la marque, sans bibliothèque
  function confettis(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const L = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = L * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const couleurs = ['#F0921E', '#F5A425', '#FFFFFF', '#FFC470', '#A85E00'];
    const morceaux = Array.from({ length: Math.min(260, Math.round(L / 5)) }, () => ({
      x: Math.random() * L, y: -20 - Math.random() * H * 0.6,
      vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
      t: 6 + Math.random() * 8, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      c: couleurs[Math.floor(Math.random() * couleurs.length)],
    }));
    const fin = performance.now() + 7000;
    const image = now => {
      if (!canvas.isConnected) return;
      ctx.clearRect(0, 0, L, H);
      let vivants = 0;
      for (const m of morceaux) {
        m.vy += 0.05; m.vx *= 0.995; m.x += m.vx + Math.sin(m.y / 40) * 0.6; m.y += m.vy; m.r += m.vr;
        if (m.y < H + 20) vivants++;
        ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.r);
        ctx.fillStyle = m.c; ctx.fillRect(-m.t / 2, -m.t / 4, m.t, m.t / 2);
        ctx.restore();
      }
      if (vivants && now < fin) requestAnimationFrame(image);
      else ctx.clearRect(0, 0, L, H);
    };
    requestAnimationFrame(image);
  }

  // =========================================================================
  //  Démarrage
  // =========================================================================
  async function demarrer() {
    try {
      etat = await api(`?annee=${ANNEE}`);
    } catch (e) {
      $('vue').innerHTML = `<section><p class="av-avert">${ico('alerte')}<span>${echap(e.message)}</span></p>
        <button type="button" class="av-btn" onclick="location.reload()">Réessayer</button></section>`;
      return;
    }
    const demande = location.hash.slice(1);
    choisie = etat.semaines.find(s => s.id === demande)?.id
      ?? etat.semaines.find(s => statut(s) === 'en_cours')?.id
      ?? [...etat.semaines].reverse().find(s => statut(s) === 'a_tirer')?.id
      ?? etat.semaines.find(s => statut(s) === 'a_venir')?.id
      ?? etat.semaines.at(-1)?.id;
    rendre();
  }
  demarrer();
})();
