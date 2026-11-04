// ===========================================================================
//  Liste d'appels de la semaine (prise de commande)
// ===========================================================================
// Martial fournit chaque semaine une liste de clients à appeler. On l'importe
// (Excel, CSV, PDF ou texte collé), chaque ligne est rapprochée d'un client
// EasyBeer, puis la liste se vide au fil des appels. Elle est partagée entre
// les postes : un appel passé disparaît chez tout le monde.
// Rien n'est écrit dans EasyBeer.
(() => {
  const zone = document.getElementById('appels');
  if (!zone) return;

  const CDN_XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  // Un enregistrement « _liste » reste toujours présent : une liste vide côté
  // serveur ferait renvoyer par un autre poste sa vieille copie locale.
  const META = '_liste';
  const magasin = creerMagasin('appels', { surChangement: () => rendre() });
  let clients = null, apercu = null, voirPasses = false, annulation = null;
  let ouvert = (() => { try { return localStorage.getItem('lgdm-appels-ouvert') !== '0'; } catch { return true; } })();

  const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtD = t => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const MOTS_VIDES = /\b(sarl|sas|sasu|eurl|sa|sci|snc|ste|societe|ets|le|la|les|l|de|du|des|d|et|chez|au|aux)\b/g;
  const cleNom = s => norm(s).replace(MOTS_VIDES, ' ').replace(/\s+/g, ' ').trim();
  const RE_TEL = /(?:\+33\s?|0)[1-9](?:[\s.\-]?\d{2}){4}/;

  const appels = () => magasin.tout().filter(a => a.id !== META);
  const meta = () => magasin.tout().find(a => a.id === META);
  const aAppeler = () => appels().filter(a => a.statut === 'a_appeler')
    .sort((a, b) => (a.tentatives ?? 0) - (b.tentatives ?? 0) || a.ordre - b.ordre);
  const passes = () => appels().filter(a => a.statut !== 'a_appeler').sort((a, b) => (b.faitLe ?? 0) - (a.faitLe ?? 0));

  async function chargerClients() {
    if (!clients) clients = (await (await fetch('/api/clients')).json()).map(c => ({ ...c, cle: cleNom(c.nom) }));
    return clients;
  }

  // --- Rapprochement d'un nom (ou d'une ligne entière) avec un client -------
  function trouverClient(texte) {
    const n = cleNom(texte);
    if (n.length < 3) return null;
    // Homonymes (deux fiches EasyBeer au même nom, cela existe) : on retient
    // la fiche la plus récente et on le signale.
    const plusRecente = l => ({ ...l.reduce((a, b) => (b.id > a.id ? b : a)), homonymes: l.length });
    const exact = clients.filter(c => c.cle === n);
    if (exact.length) return exact.length === 1 ? exact[0] : plusRecente(exact);
    // Nom du client contenu dans la ligne (ou l'inverse) : le plus long gagne.
    const inclus = clients.filter(c => c.cle.length >= 4 && (` ${n} `.includes(` ${c.cle} `) || (n.length >= 6 && c.cle.includes(n))))
      .sort((a, b) => b.cle.length - a.cle.length);
    if (inclus.length) {
      const memes = inclus.filter(c => c.cle === inclus[0].cle);
      if (inclus.length === memes.length || inclus[0].cle.length > inclus[memes.length].cle.length)
        return memes.length === 1 ? memes[0] : plusRecente(memes);
    }
    // Mots en commun.
    const mots = new Set(n.split(' ').filter(m => m.length >= 3));
    if (!mots.size) return null;
    let meilleur = null, score = 0, egalite = false;
    for (const c of clients) {
      const mc = c.cle.split(' ').filter(m => m.length >= 3);
      if (!mc.length) continue;
      const communs = mc.filter(m => mots.has(m)).length;
      const s = communs / Math.max(mc.length, mots.size);
      if (s > score) { meilleur = c; score = s; egalite = false; } else if (s === score) egalite = true;
    }
    return score >= 0.6 && !egalite ? meilleur : null;
  }

  // --- Lecture des fichiers -------------------------------------------------
  function chargerScript(src) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error('lecteur Excel inaccessible (connexion ?)'));
      document.head.appendChild(s);
    });
  }
  async function lireFichier(f) {
    const nom = f.name.toLowerCase();
    if (/\.(xlsx|xlsm|xls|ods)$/.test(nom)) {
      if (!window.XLSX) await chargerScript(CDN_XLSX);
      // dateNF : le format de date « court » d'Excel (code 14) sort sinon à
      // l'américaine (10/23/26).
      const classeur = XLSX.read(await f.arrayBuffer(), { type: 'array', dateNF: 'dd/mm/yyyy' });
      const feuille = classeur.Sheets[classeur.SheetNames[0]];
      return XLSX.utils.sheet_to_json(feuille, { header: 1, raw: false, defval: '' });
    }
    if (/\.pdf$/.test(nom)) {
      if (typeof lirePDF !== 'function') throw new Error('lecteur PDF indisponible');
      return (await lirePDF(f)).split('\n').map(l => [l]);
    }
    return lignesTexte(await f.text());
  }
  function lignesTexte(t) {
    // Séparateur choisi ligne par ligne : un copier-coller mêle souvent
    // tabulations (Excel) et points-virgules (mail, CSV).
    return t.split(/\r?\n/).filter(l => l.trim())
      .map(l => l.includes('\t') ? l.split('\t') : l.includes(';') ? l.split(';') : [l]);
  }

  // Colonnes repérées par leur en-tête, sinon par leur contenu.
  // Ancrés en début de cellule : un nom de client ne doit pas passer pour un en-tête.
  const ENTETES = {
    nom: /^(nom|client|raison sociale|enseigne|[eé]tablissement|soci[eé]t[eé]|magasin|compte)\b/i,
    tel: /^(t[eé]l|phone|portable|mobile|num[eé]ro)/i,
    contact: /^(contact|interlocuteur|responsable|g[eé]rant)/i,
    date: /^(date|derni[eè]re)/i,
    note: /^(comment|communication|note|remarque|objet|info|observation|motif|produit|[aà] proposer)/i,
  };
  const estEntete = (c, re) => !!c && c.length <= 40 && re.test(c);
  function lireEntetes(r) {
    const t = {};
    r.forEach((c, j) => {
      for (const [k, re] of Object.entries(ENTETES)) if (t[k] === undefined && estEntete(c, re)) { t[k] = j; break; }
    });
    return t;
  }

  // Une feuille peut contenir plusieurs tableaux côte à côte (ex. la liste de
  // Martial : déjà contactés à gauche, à appeler à droite). Chaque colonne
  // « Magasin / Client » de la ligne d'en-tête ouvre un tableau ; chacun est
  // lu à part et l'aperçu permet de choisir lequel importer.
  function analyser(lignes) {
    lignes = lignes.map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(Boolean));
    let h = -1;
    for (let i = 0; i < Math.min(5, lignes.length); i++) if (lignes[i].some(c => estEntete(c, ENTETES.nom))) { h = i; break; }
    if (h < 0) return analyserBloc(lignes, -1).map(x => ({ ...x, tableau: 0 }));
    const entete = lignes[h];
    const noms = entete.map((c, j) => estEntete(c, ENTETES.nom) ? j : -1).filter(j => j >= 0);
    const decalage = noms[0] - entete.findIndex(Boolean);
    const debuts = noms.map(j => Math.max(0, j - decalage));
    return debuts.flatMap((d, k) =>
      analyserBloc(lignes.map(r => r.slice(d, debuts[k + 1] ?? undefined)), h).map(x => ({ ...x, tableau: k })));
  }

  function analyserBloc(lignes, h) {
    const cols = h >= 0 ? lireEntetes(lignes[h]) : {};
    const donnees = lignes.slice(h + 1).filter(r => r.some(Boolean));
    if (cols.nom === undefined && donnees.some(r => r.length > 1)) {
      // Pas d'en-tête : la colonne « nom » est celle qui reconnaît le plus de clients.
      const largeur = Math.max(...donnees.map(r => r.length));
      let best = -1, bestScore = -1;
      for (let j = 0; j < largeur; j++) {
        const s = donnees.slice(0, 40).filter(r => r[j] && !RE_TEL.test(r[j]) && trouverClient(r[j])).length;
        if (s > bestScore) { best = j; bestScore = s; }
      }
      cols.nom = best;
    }
    const sortie = [], vus = new Set();
    donnees.forEach((r, i) => {
      const brut = r.join(' ');
      const tel = (cols.tel !== undefined ? r[cols.tel] ?? '' : '') || (brut.match(RE_TEL) ?? [''])[0];
      const nom = cols.nom !== undefined ? r[cols.nom] ?? '' : brut.replace(RE_TEL, ' ').replace(/\s+/g, ' ').trim();
      if (!nom || RE_TEL.test(nom) && nom.replace(RE_TEL, '').trim().length < 2) return;
      const client = trouverClient(nom) ?? (r.length === 1 ? null : trouverClient(brut));
      const pris = new Set([cols.nom, cols.tel, cols.contact, cols.date]);
      const autres = r.filter((c, j) => c && !pris.has(j) && !RE_TEL.test(c));
      const cle = client ? `c${client.id}` : `n${norm(nom)}`;
      if (vus.has(cle)) return;
      vus.add(cle);
      sortie.push({
        nom: nom.slice(0, 120), telephone: tel.trim(),
        contact: cols.contact !== undefined ? (r[cols.contact] ?? '').slice(0, 80) : '',
        derniere: cols.date !== undefined ? (r[cols.date] ?? '').slice(0, 30) : '',
        note: (cols.note !== undefined ? r[cols.note] ?? '' : (cols.nom !== undefined ? autres.join(' · ') : '')).slice(0, 200),
        // Ni client reconnu ni téléphone : souvent un titre ou une ligne de
        // décor (PDF) ; proposé décoché, on peut le cocher.
        client, garder: !!client || !!tel.trim(), ordre: i,
      });
    });
    return sortie;
  }

  // --- Rendu ----------------------------------------------------------------
  function rendre() {
    const m = meta(), restants = aAppeler(), faits = passes(), total = restants.length + faits.length;
    document.querySelector('main')?.classList.toggle('appels-actifs', !!total || !!apercu);
    if (apercu) return rendreApercu();
    const entete = `<div class="appels-tete">
        <button class="appels-titre" id="ap-plier" aria-expanded="${ouvert}">
          <h2 id="titre-appels">Appels de la semaine</h2>
          ${total ? `<span class="appels-compte">${restants.length} à appeler · ${faits.length} / ${total} passés</span>` : ''}
        </button>
        <span class="appels-actions">
          <button class="bouton-petit" id="ap-importer">${total ? 'Nouvelle liste' : 'Importer'}</button>
          <button class="bouton-petit" id="ap-coller">Coller</button>
        </span>
        <input type="file" id="ap-fichier" accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,.pdf" hidden>
      </div>`;
    if (!ouvert) { zone.innerHTML = entete; brancherTete(); return; }
    if (!total) {
      zone.innerHTML = entete + `<p class="carte-soustitre">Facultatif : importez la liste d'appels de la semaine
        (Excel, CSV, PDF, ou copier-coller). Chaque client se retire de la liste quand l'appel est passé ou qu'il a commandé.</p>`;
      brancherTete(); return;
    }
    const barre = total ? `<div class="appels-barre"><i style="width:${Math.round(faits.length / total * 100)}%"></i></div>` : '';
    zone.innerHTML = entete + barre
      + (m?.importeLe ? `<p class="carte-soustitre">Liste importée ${fmtD(m.importeLe)}${m.source ? ` · ${echap(m.source)}` : ''}</p>` : '')
      + (annulation ? `<p class="appels-annuler">${echap(annulation.texte)} <button class="bouton-lien" id="ap-annuler">Annuler</button></p>` : '')
      + `<ul class="appels-liste">${restants.map(ligne).join('')
        || '<li class="appels-fini">Tous les appels de la liste sont passés.</li>'}</ul>`
      + (faits.length ? `<button class="bouton-lien" id="ap-voir">${voirPasses ? 'Masquer' : 'Voir'} les appels passés (${faits.length})</button>` : '')
      + (voirPasses ? `<ul class="appels-liste passes">${faits.map(lignePasse).join('')}</ul>` : '')
      + `<button class="bouton-lien danger" id="ap-vider">Vider la liste</button>`;
    brancherTete();
    zone.querySelectorAll('[data-ap]').forEach(b => b.addEventListener('click', () => action(b.dataset.ap, b.closest('[data-id]').dataset.id)));
    zone.querySelector('#ap-voir')?.addEventListener('click', () => { voirPasses = !voirPasses; rendre(); });
    zone.querySelector('#ap-annuler')?.addEventListener('click', annuler);
    zone.querySelector('#ap-vider').addEventListener('click', async () => {
      if (!confirm('Vider la liste d’appels pour toute l’équipe ?')) return;
      await Promise.all(appels().map(a => magasin.supprimer(a.id)));
      await magasin.enregistrer({ id: META, importeLe: null, source: '' });
    });
  }

  // Une ligne compacte : le nom, les infos utiles sur une seule ligne, puis
  // les quatre actions côte à côte.
  function ligne(a) {
    const nom = a.nomClient || a.nom;
    // Une cellule peut contenir deux numéros : on appelle le premier.
    const tel = (String(a.telephone ?? '').match(RE_TEL) ?? [a.telephone])[0]?.trim();
    const infos = [
      a.canal,
      a.derniereCommande && `dern. cde ${a.derniereCommande}`,
      a.tentatives && `sans réponse ×${a.tentatives}`,
      !a.idClient && 'non reconnu dans EasyBeer',
      a.contact,
    ].filter(Boolean).map(echap).join(' · ');
    const extra = [a.nomClient && norm(a.nomClient) !== norm(a.nom) ? `liste : ${a.nom}` : '', a.note].filter(Boolean).map(echap).join(' · ');
    return `<li data-id="${echap(a.id)}">
      <div class="appels-qui"><b>${echap(nom)}</b>
        ${infos ? `<span class="appels-meta">${infos}</span>` : ''}
        ${extra ? `<span class="appels-meta">${extra}</span>` : ''}</div>
      <div class="appels-btns">
        ${tel ? `<a class="bouton-petit tel" href="tel:${echap(tel.replace(/[^\d+]/g, ''))}" title="Appeler ${echap(a.telephone)}">${ico('telephone')}${echap(tel)}</a>` : ''}
        ${a.idClient ? '<button class="bouton-petit principal" data-ap="commander">Commander</button>' : ''}
        <button class="bouton-petit" data-ap="absent" title="Pas de réponse : le garder pour plus tard, en fin de liste">Plus tard</button>
        <button class="bouton-petit ok" data-ap="fait" title="Appel passé : retirer de la liste" aria-label="Appelé">${ico('check')}</button>
      </div></li>`;
  }
  function lignePasse(a) {
    return `<li data-id="${echap(a.id)}"><div class="appels-qui"><b>${echap(a.nomClient || a.nom)}</b>
      <span class="appels-meta">${a.statut === 'commande' ? 'a commandé' : 'appelé'} · ${new Date(a.faitLe).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="appels-btns"><button class="bouton-petit" data-ap="remettre">Remettre</button></div></li>`;
  }

  function brancherTete() {
    zone.querySelector('#ap-plier').addEventListener('click', () => {
      ouvert = !ouvert; try { localStorage.setItem('lgdm-appels-ouvert', ouvert ? '1' : '0'); } catch {}
      rendre();
    });
    const fichier = zone.querySelector('#ap-fichier');
    zone.querySelector('#ap-importer').addEventListener('click', () => fichier.click());
    fichier.addEventListener('change', async () => {
      const f = fichier.files[0]; if (!f) return;
      await preparer(() => lireFichier(f), f.name);
    });
    zone.querySelector('#ap-coller').addEventListener('click', () => {
      apercu = { collage: true, lignes: [] }; ouvert = true; rendre();
    });
  }

  async function preparer(lire, source) {
    apercu = { chargement: true, source, lignes: [] }; ouvert = true; rendre();
    try {
      await chargerClients();
      const lignes = analyser(await lire());
      if (!lignes.length) throw new Error('aucune ligne exploitable dans ce fichier');
      const tailles = new Map();
      for (const l of lignes) tailles.set(l.tableau, (tailles.get(l.tableau) ?? 0) + 1);
      if (tailles.size > 1) {
        // Plusieurs tableaux : seul le plus long est coché d'office.
        const principal = [...tailles].sort((x, y) => y[1] - x[1])[0][0];
        lignes.forEach(l => { if (l.tableau !== principal) l.garder = false; });
      }
      apercu = { source, lignes };
    } catch (e) {
      apercu = { erreur: e.message, source, lignes: [] };
    }
    rendre();
  }

  // Aperçu avant import : on coche les lignes à garder.
  function rendreApercu() {
    const a = apercu;
    if (a.collage) {
      zone.innerHTML = `<h2 id="titre-appels">Coller la liste d'appels</h2>
        <p class="carte-soustitre">Copiez les lignes depuis Excel, un mail ou un document (un client par ligne) et collez-les ici.</p>
        <textarea id="ap-texte" rows="8" placeholder="Le Galichon	05 61 00 00 00	relancer bière de Noël"></textarea>
        <div class="appels-pied"><button class="bouton-petit principal" id="ap-lire">Lire la liste</button>
          <button class="bouton-petit" id="ap-fermer">Annuler</button></div>`;
      zone.querySelector('#ap-lire').addEventListener('click', () => {
        const t = zone.querySelector('#ap-texte').value;
        preparer(async () => lignesTexte(t), 'liste collée');
      });
      zone.querySelector('#ap-fermer').addEventListener('click', () => { apercu = null; rendre(); });
      zone.querySelector('#ap-texte').focus();
      return;
    }
    if (a.chargement) { zone.innerHTML = '<h2 id="titre-appels">Appels de la semaine</h2><p class="carte-soustitre"><span class="loader"></span> Lecture de la liste…</p>'; return; }
    if (a.erreur) {
      zone.innerHTML = `<h2 id="titre-appels">Appels de la semaine</h2><p class="appels-erreur">Lecture impossible : ${echap(a.erreur)}</p>
        <div class="appels-pied"><button class="bouton-petit" id="ap-fermer">Fermer</button></div>`;
      zone.querySelector('#ap-fermer').addEventListener('click', () => { apercu = null; rendre(); });
      return;
    }
    const reconnus = a.lignes.filter(l => l.client).length, gardes = a.lignes.filter(l => l.garder).length;
    const ks = [...new Set(a.lignes.map(l => l.tableau))].sort((x, y) => x - y);
    const tableaux = ks.map((k, n) => {
      const lignes = a.lignes.map((l, i) => ({ l, i })).filter(x => x.l.tableau === k);
      const position = ks.length === 2 ? (n === 0 ? 'de gauche' : 'de droite') : `n° ${n + 1}`;
      return { k, lignes, coches: lignes.filter(x => x.l.garder).length, nomTableau: `Tableau ${position}` };
    });
    const existe = appels().length > 0;
    zone.innerHTML = `<h2 id="titre-appels">Importer la liste d'appels</h2>
      <p class="carte-soustitre">${echap(a.source)} · ${a.lignes.length} ligne(s) lue(s), ${reconnus} client(s) reconnu(s) dans EasyBeer.
        Décochez ce qui ne doit pas être importé.</p>
      <div class="appels-liste apercu">${tableaux.map(t => `
        ${tableaux.length > 1 ? `<label class="appels-coche appels-tableau"><input type="checkbox" data-t="${t.k}" ${t.coches ? 'checked' : ''}>
          <span><b>${t.nomTableau}</b><span class="appels-meta">${t.lignes.length} ligne(s), ${t.lignes.filter(x => x.l.client).length} client(s) reconnu(s)${t.coches && t.coches < t.lignes.length ? ` · ${t.coches} cochée(s)` : ''}</span></span></label>` : ''}
        ${t.coches || tableaux.length === 1 ? `<ul class="appels-liste">${t.lignes.map(({ l, i }) => `<li>
        <label class="appels-coche"><input type="checkbox" data-i="${i}" ${l.garder ? 'checked' : ''}>
          <span><b>${echap(l.client?.nom ?? l.nom)}</b>
          ${l.client ? (norm(l.client.nom) !== norm(l.nom) ? `<span class="appels-meta">liste : ${echap(l.nom)}</span>` : '') : '<span class="appels-meta">non reconnu dans EasyBeer</span>'}
          ${l.client?.homonymes ? `<span class="appels-meta">${l.client.homonymes} fiches EasyBeer à ce nom : la plus récente est retenue</span>` : ''}
          ${l.telephone ? `<span class="appels-meta">${echap(l.telephone)}</span>` : ''}
          ${l.derniere ? `<span class="appels-meta">dernière commande : ${echap(l.derniere)}</span>` : ''}
          ${l.note ? `<span class="appels-meta">${echap(l.note)}</span>` : ''}</span></label></li>`).join('')}</ul>` : ''}`).join('')}</div>
      <div class="appels-pied">
        <button class="bouton-petit principal" id="ap-remplacer" ${gardes ? '' : 'disabled'}>${existe ? 'Remplacer la liste actuelle' : 'Importer'} (${gardes})</button>
        ${existe ? `<button class="bouton-petit" id="ap-ajouter" ${gardes ? '' : 'disabled'}>Ajouter à la liste</button>` : ''}
        <button class="bouton-petit" id="ap-fermer">Ne pas importer</button>
      </div>`;
    zone.querySelectorAll('[data-i]').forEach(c => c.addEventListener('change', () => { a.lignes[+c.dataset.i].garder = c.checked; rendre(); }));
    zone.querySelectorAll('[data-t]').forEach(c => c.addEventListener('change', () => {
      a.lignes.forEach(l => { if (l.tableau === +c.dataset.t) l.garder = c.checked && (!!l.client || !!l.telephone); });
      rendre();
    }));
    zone.querySelector('#ap-remplacer').addEventListener('click', () => importer(true));
    zone.querySelector('#ap-ajouter')?.addEventListener('click', () => importer(false));
    zone.querySelector('#ap-fermer').addEventListener('click', () => { apercu = null; rendre(); });
  }

  async function importer(remplacer) {
    const a = apercu; apercu = null;
    zone.innerHTML = '<h2 id="titre-appels">Appels de la semaine</h2><p class="carte-soustitre"><span class="loader"></span> Enregistrement…</p>';
    if (remplacer) await Promise.all(appels().map(x => magasin.supprimer(x.id)));
    const deja = new Set(appels().map(x => x.idClient ? `c${x.idClient}` : `n${norm(x.nom)}`));
    const base = Date.now();
    const nouveaux = a.lignes.filter(l => l.garder).map((l, i) => ({
      id: `${base.toString(36)}-${i}`, ordre: base + i, statut: 'a_appeler', tentatives: 0,
      nom: l.nom, telephone: l.telephone, contact: l.contact, note: l.note, derniereCommande: l.derniere,
      idClient: l.client?.id ?? null, nomClient: l.client?.nom ?? '', canal: l.client?.canal ?? '',
    })).filter(x => !deja.has(x.idClient ? `c${x.idClient}` : `n${norm(x.nom)}`));
    await magasin.enregistrer({ id: META, importeLe: Date.now(), source: a.source });
    await Promise.all(nouveaux.map(x => magasin.enregistrer(x)));
    ouvert = true; rendre();
  }

  // --- Actions sur un appel -------------------------------------------------
  async function action(type, id) {
    const a = magasin.tout().find(x => String(x.id) === String(id)); if (!a) return;
    if (type === 'commander') {
      const ok = await window.selectionnerClient?.(a.idClient);
      if (!ok) alert('Client introuvable dans la liste de la prise de commande.');
      return;
    }
    if (type === 'absent') return magasin.enregistrer({ ...a, tentatives: (a.tentatives ?? 0) + 1, dernierEssai: Date.now() });
    if (type === 'remettre') return magasin.enregistrer({ ...a, statut: 'a_appeler', faitLe: null });
    if (type === 'fait') marquer(a, 'appele');
  }
  function marquer(a, statut) {
    annulation = { texte: `${a.nomClient || a.nom} retiré de la liste.`, avant: { ...a } };
    clearTimeout(marquer.t); marquer.t = setTimeout(() => { annulation = null; rendre(); }, 8000);
    magasin.enregistrer({ ...a, statut, faitLe: Date.now() });
  }
  function annuler() {
    if (!annulation) return;
    magasin.enregistrer(annulation.avant); annulation = null; rendre();
  }

  // Appelé par la prise de commande après un envoi (ou une mise en attente).
  window.appels = {
    commandePassee(idClient) {
      const a = aAppeler().find(x => String(x.idClient) === String(idClient));
      if (a) marquer(a, 'commande');
    },
  };

  rendre();
  magasin.charger().then(rendre);
  magasin.suivre(30_000);
})();
