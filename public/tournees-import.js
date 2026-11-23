// ===========================================================================
//  Import des arrêts d'une tournée : Excel, CSV, PDF ou liste collée
// ===========================================================================
// Tout se passe dans le navigateur. Le but n'est pas de deviner parfaitement :
// c'est de proposer une première lecture juste dans la plupart des cas, que
// la brasserie vérifie et corrige dans l'aperçu avant de l'ajouter.
//
// Trois formes de sources reconnues :
//   • tableau (Excel, CSV, copier-coller depuis un tableur) : colonnes
//     repérées par leur en-tête, sinon par leur contenu ;
//   • blocs (mail, PDF de bons de livraison) : un client par paragraphe,
//     nom en tête, puis adresse, téléphone, consignes ;
//   • une ligne par client (« Bar X - 12 rue Y 31000 Toulouse - 06… »).
(function (racine) {
  const RE_TEL = /(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/;
  const RE_TEL_G = new RegExp(RE_TEL.source, 'g');
  const RE_CP = /\b(?:0[1-9]|[1-8]\d|9[0-8])\d{3}\b/;
  const VOIES = 'rue|r\\.|av\\.?|ave|avenue|bd|boulevard|chemin|che|ch\\.|route|rte|impasse|imp\\.?|all[ée]e|all[ée]es|place|pl\\.|quai|cours|lotissement|lot\\.|r[ée]sidence|zone|za|zi|zac|faubourg|fbg|passage|square|voie|esplanade|promenade|rond-point|sentier|mont[ée]e|traverse|cit[ée]|hameau|lieu[- ]dit|parvis|parc|domaine|ld';
  const RE_VOIE = new RegExp(`(^|[\\s,])(${VOIES})(?=[\\s.,]|$)`, 'i');
  const RE_VOIE_DEBUT = new RegExp(`^(${VOIES})(?=[\\s.,]|$)`, 'i');
  const RE_NUMERO_VOIE = new RegExp(`(^|[\\s,])\\d{1,4}\\s*(bis|ter|quater|[a-d])?\\s*,?\\s+(${VOIES})(?=[\\s.,]|$)`, 'i');

  // En-têtes reconnus, ancrés en début de cellule (une valeur ne doit pas
  // passer pour un en-tête). L'ordre compte : « adresse de livraison » est
  // une adresse avant d'être une consigne.
  const ENTETES = [
    ['telephone', /^(t[eé]l(\.|[eé]phone)?|phone|portable|mobile|gsm|num[eé]ro de t)/i],
    ['ordre', /^(n[°o]\.?|num[eé]ro|ordre|rang|position|arr[eê]t|#)\s*$/i],
    ['cp', /^(cp|code ?postal|c\.p\.?|postal|zip)\b/i],
    ['ville', /^(ville|commune|localit[eé]|city)\b/i],
    ['complement', /^(compl[eé]ment|adresse ?2|ligne ?2|b[aâ]timent)/i],
    // Exports de planificateurs d'itinéraire : une ligne par trajet (De → Vers)
    ['de', /^(de|depuis|from|origine|provenance|point de d[eé]part|adresse de d[eé]part)\s*$/i],
    ['vers', /^(vers|[àa]|to|destination|jusqu'?[àa]|point d'arriv[eé]e|adresse d'arriv[eé]e)\s*$/i],
    ['depart', /^(d[eé]part|heure de d[eé]part|h\.? ?d[eé]part)\s*$/i],
    ['arrivee', /^(arriv[eé]e|heure d'arriv[eé]e|h\.? ?arriv[eé]e|eta)\s*$/i],
    ['heure', /^(heure|horaire pr[eé]vu|heure pr[eé]vue|rdv|rendez-vous)\s*$/i],
    ['distance', /^(distance|km|kilom[eè]tres?)\b/i],
    ['duree', /^(dur[eé]e|temps)\b/i],
    ['adresse', /^(adresse|addr|rue|voie|n[°o]? et rue|lieu de livraison|adresse de livraison|ligne ?1)/i],
    ['nom', /^(nom|client|raison sociale|enseigne|[eé]tablissement|soci[eé]t[eé]|destinataire|magasin|compte|point de livraison|libell[eé])/i],
    ['contact', /^(contact|interlocuteur|responsable|g[eé]rant)/i],
    ['consignes', /^(consigne|instruction|commentaire|note|remarque|observation|info|horaire|acc[eè]s|pr[eé]cision|livraison|message)/i],
    ['email', /^(e-?mail|courriel|mail)\b/i],
  ];
  const CHAMPS = ['nom', 'adresse', 'complement', 'cp', 'ville', 'telephone', 'consignes', 'contact', 'ordre'];

  const estAdresse = v => !!v && !/@/.test(v) && !RE_TEL.test(v)
    && (RE_CP.test(v) || RE_NUMERO_VOIE.test(v) || (RE_VOIE.test(v) && /\d/.test(v)));
  const RE_HEURE = /^\d{1,2}\s*[:h]\s*\d{2}(:\d{2})?$/i;
  // Valeurs inutiles au livreur : heures isolées, distances, durées, e-mails.
  const estTechnique = v => RE_HEURE.test(v) || /^[\d.,]+\s*(km|m)$/i.test(v)
    || /^(\d+\s*h\s*)?\d+\s*min(\s*\d+\s*s)?$/i.test(v) || /^\d+\s*s$/i.test(v) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v);
  const propre = s => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
  const estEntete = c => !!c && c.length <= 40 && !RE_TEL.test(c) && !/^\d+$/.test(c);
  function champEntete(c) {
    if (!estEntete(c)) return null;
    for (const [champ, re] of ENTETES) if (re.test(c)) return champ;
    return null;
  }

  // --- Téléphone -------------------------------------------------------------
  function formaterTel(t) {
    const s = propre(t);
    const m = s.match(RE_TEL);
    if (!m) return s.slice(0, 40);
    let d = m[0].replace(/[^\d+]/g, '');
    if (d.startsWith('0033')) d = '+33' + d.slice(4);
    if (d.startsWith('+33') && d.length === 12) return '+33 ' + d.slice(3, 4) + ' ' + d.slice(4).replace(/(\d{2})(?=\d)/g, '$1 ');
    if (/^0\d{9}$/.test(d)) return d.replace(/(\d{2})(?=\d)/g, '$1 ');
    return m[0];
  }
  const telEnLien = t => {
    const m = String(t ?? '').match(RE_TEL);
    if (!m) { const d = String(t ?? '').replace(/[^\d+]/g, ''); return d.length >= 6 ? d : ''; }
    let d = m[0].replace(/[^\d+]/g, '');
    if (d.startsWith('0033')) d = '+33' + d.slice(4);
    return d;
  };

  // --- Contrôle de forme d'une adresse (même règle que le serveur) ----------
  function controleForme(adresse) {
    const a = propre(adresse);
    if (!a) return { niveau: 'erreur', message: 'Adresse manquante' };
    if (a.length < 8) return { niveau: 'erreur', message: 'Adresse incomplète' };
    const manque = [];
    if (!RE_CP.test(a)) manque.push('code postal');
    if (!RE_NUMERO_VOIE.test(a) && !/^\s*\d/.test(a)) manque.push('numéro de rue');
    if (manque.length === 2) return { niveau: 'erreur', message: 'Adresse incomplète : ni code postal ni numéro de rue' };
    if (manque.length) return { niveau: 'avertissement', message: `Adresse incomplète : ${manque[0]} absent` };
    return { niveau: 'ok', message: '' };
  }

  // --- Composition d'un arrêt à partir de morceaux ---------------------------
  const sansPays = s => propre(s).replace(/,?\s*france\s*$/i, '');
  function composerAdresse(rue, cp, ville) {
    rue = sansPays(rue); cp = propre(cp); ville = sansPays(ville);
    // Code postal lu comme nombre par le tableur : 1150 → 01150
    if (/^\d{4}$/.test(cp)) cp = '0' + cp;
    const fin = [cp, ville].filter(Boolean).join(' ');
    if (!fin) return rue;
    const n = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (rue && (cp && rue.includes(cp) || ville && n(rue).includes(n(ville)) && (!cp || rue.includes(cp)))) return rue;
    return [rue, fin].filter(Boolean).join(', ');
  }
  function arret({ nom = '', adresse = '', telephone = '', consignes = [] } = {}) {
    const c = (Array.isArray(consignes) ? consignes : [consignes]).map(propre).filter(Boolean);
    return {
      nom: propre(nom).slice(0, 120),
      adresse: propre(adresse).replace(/\s*,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '').slice(0, 300),
      telephone: telephone ? formaterTel(telephone) : '',
      consignes: [...new Set(c)].join('\n').slice(0, 1000),
    };
  }

  // --- Tableaux ------------------------------------------------------------------
  function trouverEntete(lignes) {
    let best = -1, bestN = 0;
    for (let i = 0; i < Math.min(8, lignes.length); i++) {
      const champs = new Set(lignes[i].map(champEntete).filter(Boolean));
      const n = champs.size + (champs.has('nom') || champs.has('adresse') ? 1 : 0);
      if (n > bestN && champs.size >= 2) { best = i; bestN = n; }
    }
    return best;
  }

  function lireEntetes(entete) {
    const cols = {};
    entete.forEach((c, j) => {
      const champ = champEntete(c);
      if (champ && cols[champ] === undefined) cols[champ] = j;
    });
    return cols;
  }

  // Sans en-tête : chaque colonne est jugée sur son contenu.
  function devinerColonnes(donnees) {
    const largeur = Math.max(0, ...donnees.map(r => r.length));
    const ech = donnees.slice(0, 60);
    const part = (j, test) => {
      const v = ech.map(r => r[j]).filter(Boolean);
      return v.length ? v.filter(test).length / v.length : 0;
    };
    const cols = {}, pris = new Set();
    const prendre = (champ, j) => { if (j >= 0 && !pris.has(j)) { cols[champ] = j; pris.add(j); } };
    const meilleure = test => {
      let b = -1, s = 0;
      for (let j = 0; j < largeur; j++) if (!pris.has(j)) { const p = part(j, test); if (p > s) { s = p; b = j; } }
      return s >= 0.5 ? b : -1;
    };
    prendre('telephone', meilleure(v => RE_TEL.test(v)));
    prendre('ordre', meilleure(v => /^\d{1,3}$/.test(v) && Number(v) <= 500));
    prendre('cp', meilleure(v => /^\d{4,5}$/.test(v)));
    if (cols.cp !== undefined && cols.cp + 1 < largeur && !pris.has(cols.cp + 1) && part(cols.cp + 1, v => /^[\p{L}\s'’-]+$/u.test(v)) >= 0.5) {
      prendre('ville', cols.cp + 1);
    }
    prendre('adresse', meilleure(v => RE_NUMERO_VOIE.test(v) || RE_VOIE.test(v) || RE_CP.test(v)));
    prendre('nom', meilleure(v => /\p{L}{2}/u.test(v) && !RE_TEL.test(v)));
    for (let j = 0; j < largeur; j++) if (!pris.has(j) && part(j, v => /\p{L}{3}/u.test(v)) >= 0.3) {
      cols.autres = [...(cols.autres ?? []), j];
    }
    return cols;
  }

  function lireTableau(lignes, imposees = null) {
    const brut = lignes.map(r => (Array.isArray(r) ? r : [r]).map(propre));
    const lignesUtiles = brut.filter(r => r.some(Boolean));
    const h = trouverEntete(lignesUtiles);
    const entete = h >= 0 ? lignesUtiles[h] : null;
    const donnees = lignesUtiles.slice(h + 1);
    let cols = imposees ? { ...imposees } : (entete ? lireEntetes(entete) : devinerColonnes(donnees));
    // Pas de colonne « nom » trouvée par l'en-tête : on la cherche par le contenu.
    if (!imposees && cols.nom === undefined && cols.adresse === undefined) cols = { ...devinerColonnes(donnees), ...cols };
    if (!imposees) affinerColonnes(cols, donnees);
    // Avec en-tête, les colonnes non reconnues deviennent des consignes
    // (« Produits : 3 fûts »), sauf l'e-mail, inutile au livreur.
    if (entete) {
      const connues = new Set(Object.entries(cols).filter(([k, j]) => k !== 'autres' && j !== undefined && j !== null && j >= 0).map(([, j]) => j));
      cols.autres = entete.map((c, j) => j).filter(j => !connues.has(j) && entete[j] && champEntete(entete[j]) !== 'email');
    }

    const val = (r, j) => j === undefined || j === null || j < 0 ? '' : propre(r[j]);
    const base = { colonnes: cols, entete, lignes: lignesUtiles, largeur: Math.max(0, ...lignesUtiles.map(r => r.length)), forme: 'tableau' };
    if (cols.de !== undefined && cols.vers !== undefined) return { ...base, arrets: lireItineraire(donnees, cols, entete, val), itineraire: true };
    let arrets = donnees.map((r, i) => ({
      ...arretDeLigne(r, cols, entete, val, composerAdresse(val(r, cols.adresse), val(r, cols.cp), val(r, cols.ville))),
      _ordre: Number(val(r, cols.ordre)) || null, _ligne: i,
    })).filter(a => a.nom || a.adresse);
    // Totaux, sous-titres : une ligne sans adresse ni téléphone dont le « nom »
    // est un mot isolé (TOTAL, Tournée 2…) n'est pas un client.
    arrets = arrets.filter(a => a.adresse || a.telephone || !/^(total|sous-total|tourn[ée]e)\b/i.test(a.nom));
    if (cols.ordre !== undefined && arrets.every(a => a._ordre)) arrets.sort((a, b) => a._ordre - b._ordre || a._ligne - b._ligne);
    return { ...base, arrets: arrets.map(({ _ordre, _ligne, ...a }) => a) };
  }

  // Une ligne de client → arrêt (l'adresse est fournie par l'appelant).
  function arretDeLigne(r, cols, entete, val, adresse) {
    // Cellule par cellule : une heure voisine (« 09:08 ») fausserait le numéro.
    const tel = val(r, cols.telephone) || (r.map(propre).find(c => RE_TEL.test(c))?.match(RE_TEL)[0] ?? '');
    const consignes = [val(r, cols.consignes)];
    if (val(r, cols.complement)) consignes.unshift(`Complément d’adresse : ${val(r, cols.complement)}`);
    if (val(r, cols.heure)) consignes.unshift(`Horaire prévu : ${val(r, cols.heure)}`);
    if (val(r, cols.contact)) consignes.push(`Contact : ${val(r, cols.contact)}`);
    for (const j of cols.autres ?? []) {
      const v = val(r, j);
      if (!v || estTechnique(v) || (RE_TEL.test(v) && tel)) continue;
      consignes.push(entete?.[j] ? `${entete[j]} : ${v}` : v);
    }
    return arret({ nom: val(r, cols.nom), adresse, telephone: tel, consignes });
  }

  // Colonnes « Départ » / « Arrivée » : adresses (trajet) ou heures selon leur
  // contenu. Une colonne « Destination » seule est l'adresse du client.
  function affinerColonnes(cols, donnees) {
    const part = (j, test) => {
      const v = donnees.slice(0, 80).map(r => propre(r[j])).filter(Boolean);
      return v.length ? v.filter(test).length / v.length : 0;
    };
    const heures = {};
    for (const [k, adr] of [['depart', 'de'], ['arrivee', 'vers']]) {
      const j = cols[k];
      if (j === undefined) continue;
      delete cols[k];                    // ni adresse ni heure : reste en consigne
      if (cols[adr] === undefined && part(j, estAdresse) >= 0.3) cols[adr] = j;
      else if (part(j, v => RE_HEURE.test(v)) >= 0.5) heures[k] = j;
    }
    if (cols.vers !== undefined && cols.de === undefined && cols.adresse === undefined) { cols.adresse = cols.vers; delete cols.vers; }
    if (cols.de !== undefined && cols.vers === undefined) delete cols.de;
    // Itinéraire : sur la ligne d'un client, « Départ » est le début de l'arrêt,
    // donc l'heure d'arrivée chez lui. Liste simple : on préfère « Arrivée ».
    const itin = cols.de !== undefined && cols.vers !== undefined;
    const choix = itin ? (heures.depart ?? heures.arrivee) : (heures.arrivee ?? heures.depart);
    if (cols.heure === undefined && choix !== undefined) cols.heure = choix;
  }

  // Export d'itinéraire : des lignes de trajet (De → Vers) encadrent les
  // lignes de clients. L'adresse d'un client est la destination du trajet
  // qui y mène ; sur sa propre ligne, De/Vers portent souvent son téléphone
  // et son e-mail. Les trajets eux-mêmes (Départ, Trajet, Retour) et le
  // retour au dépôt ne sont pas des livraisons.
  const LIBELLE_TRAJET = /^(d[ée]part|trajet|retour|arriv[ée]e|total|pause|d[ée]p[ôo]t|fin|d[ée]but)\b/i;
  function lireItineraire(donnees, cols, entete, val) {
    const cle = s => sansPays(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const sortie = [];
    let depot = null, attente = null;
    const libre = lib => lib && !LIBELLE_TRAJET.test(lib) ? lib : '';
    const trajetSeul = t => arret({ nom: libre(t.libelle), adresse: t.adresse });
    for (const r of donnees) {
      if (r.some(c => /^(sous-)?total\b/i.test(propre(c)))) continue;
      const de = val(r, cols.de), vers = val(r, cols.vers);
      if (estAdresse(vers) && (!de || estAdresse(de))) {
        if (depot === null) depot = de ? cle(de) : '';
        // Deux trajets de suite : la destination du premier était un arrêt
        // sans ligne de client.
        if (attente && cle(attente.adresse) !== depot) sortie.push(trajetSeul(attente));
        attente = { adresse: sansPays(vers), libelle: val(r, cols.nom) };
        continue;
      }
      const nom = val(r, cols.nom) || libre(attente?.libelle);
      if (!nom) continue;
      const propreAdr = composerAdresse(val(r, cols.adresse), val(r, cols.cp), val(r, cols.ville));
      sortie.push(arretDeLigne(r, { ...cols, autres: (cols.autres ?? []).filter(j => j !== cols.de && j !== cols.vers) },
        entete, (rr, j) => j === cols.nom ? nom : val(rr, j), propreAdr || attente?.adresse || ''));
      attente = null;
    }
    if (attente && cle(attente.adresse) !== depot) sortie.push(trajetSeul(attente));
    return sortie.filter(a => a.nom || a.adresse);
  }

  // --- Texte libre ------------------------------------------------------------------
  const ETIQUETTE = /^(client|nom|destinataire|adresse|adr\.?|t[eé]l(\.|[eé]phone)?|portable|mobile|consignes?|instructions?|note|commentaire|remarque|horaires?|acc[eè]s)\s*[:：]\s*/i;
  const etiquetteDe = l => (l.match(ETIQUETTE)?.[1] ?? '').toLowerCase();
  const sansEtiquette = l => l.replace(ETIQUETTE, '');
  const sansNumeroListe = l => l.replace(/^\s*(?:#\s*)?\d{1,3}\s*[.)\]-]\s+(?=\D)/, '').replace(/^\s*[-•*–]\s+/, '');
  const estLigneAdresse = l => RE_CP.test(l) || RE_NUMERO_VOIE.test(l) || (RE_VOIE.test(l) && /\d/.test(l));

  function lireBloc(lignes) {
    let nom = '', tel = '';
    const rue = [], consignes = [];
    for (let brut of lignes) {
      const etiq = etiquetteDe(brut);
      let l = sansEtiquette(brut).trim();
      const m = l.match(RE_TEL);
      if (m) {
        tel = tel || m[0];
        l = l.replace(RE_TEL_G, ' ').replace(/\b(t[eé]l(\.|[eé]phone)?|portable|mobile|gsm)\s*[:.]?\s*/gi, '').replace(/^[\s,;/–-]+|[\s,;/–-]+$/g, '');
        if (!l) continue;
      }
      const adresseComplete = rue.some(r => RE_CP.test(r));
      if (/^(client|nom|destinataire)/.test(etiq)) nom = l;
      else if (/^adr/.test(etiq)) rue.push(l);
      else if (/^(consigne|instruction|note|commentaire|remarque|horaire|acc)/.test(etiq)) consignes.push(l);
      // La première ligne est le nom, sauf si c'est clairement une adresse.
      else if (!nom && !rue.length && !RE_CP.test(l) && !RE_NUMERO_VOIE.test(l)) nom = l;
      else if (!adresseComplete && estLigneAdresse(l)) rue.push(l);
      else if (!nom) nom = l;
      else consignes.push(l);
    }
    return arret({ nom, adresse: rue.join(', '), telephone: tel, consignes });
  }

  function lireLigne(l) {
    l = sansNumeroListe(l);
    const tel = (l.match(RE_TEL) ?? [''])[0];
    // Le téléphone retiré laisse un séparateur : « … Bruguières - | - livrer »
    l = l.replace(/\b(t[eé]l(\.|[eé]phone)?|portable|mobile|gsm)\s*[:.]?\s*(?=[+0])/gi, ' ').replace(RE_TEL_G, ' | ');
    const parts = l.split(/\s+[-–|]\s+|\s*[;|\t]\s*|,\s+/)
      .map(p => propre(p).replace(/^[-–|,;:\s]+|[-–|,;:\s]+$/g, '')).filter(Boolean);
    // « Bar X 12 rue Y 31000 Toulouse » sans séparateur : on coupe avant le numéro.
    const k = parts.findIndex(p => { const m = p.match(RE_NUMERO_VOIE); return m && m.index > 2; });
    if (k >= 0 && (k === 0 || !parts.slice(0, k).some(p => RE_NUMERO_VOIE.test(p)))) {
      const m = parts[k].match(RE_NUMERO_VOIE);
      parts.splice(k, 1, parts[k].slice(0, m.index).trim(), parts[k].slice(m.index).trim());
    }
    let iRue = parts.findIndex(p => RE_NUMERO_VOIE.test(p) || /^\d{1,4}\s*(bis|ter)?\s+\p{L}/u.test(p) && !RE_CP.test(p.slice(0, 5)));
    if (iRue < 0) iRue = parts.findIndex((p, i) => i > 0 && RE_VOIE_DEBUT.test(p));
    const iCP = parts.findIndex(p => RE_CP.test(p));
    let nom = '', adresse = '', consignes = [];
    if (iRue >= 0) {
      const fin = iCP >= iRue ? iCP : iRue;
      nom = parts.slice(0, iRue).join(' - ');
      adresse = parts.slice(iRue, fin + 1).join(', ');
      consignes = parts.slice(fin + 1);
    } else if (iCP >= 0) {
      const debut = iCP > 1 && RE_VOIE.test(parts[iCP - 1]) ? iCP - 1 : iCP;
      nom = parts.slice(0, debut).join(' - ');
      adresse = parts.slice(debut, iCP + 1).join(', ');
      consignes = parts.slice(iCP + 1);
    } else {
      nom = parts[0] ?? '';
      consignes = parts.slice(1);
    }
    return arret({ nom, adresse, telephone: tel, consignes });
  }

  function separateurDominant(lignes) {
    const non = lignes.filter(l => l.trim());
    if (!non.length) return null;
    for (const sep of ['\t', ';']) {
      if (non.filter(l => l.includes(sep)).length >= Math.max(1, non.length * 0.6)) return sep;
    }
    // CSV à virgules : seulement si une ligne d'en-têtes le confirme.
    const tete = decouperCSV(non[0], ',');
    if (tete.length >= 3 && tete.filter(c => champEntete(c)).length >= 2) return ',';
    return null;
  }

  // Découpe CSV respectant les guillemets ("12, rue X")
  function decouperCSV(ligneTxt, sep) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < ligneTxt.length; i++) {
      const c = ligneTxt[i];
      if (q) {
        if (c === '"' && ligneTxt[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"' && !cur.trim()) q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(propre);
  }
  // Un champ entre guillemets peut contenir un saut de ligne (consignes)
  function lignesCSV(texte) {
    const lignes = [];
    let cur = '', q = false;
    for (const c of texte.replace(/\r\n?/g, '\n')) {
      if (c === '"') q = !q;
      if (c === '\n' && !q) { lignes.push(cur); cur = ''; } else cur += c;
    }
    if (cur) lignes.push(cur);
    return lignes;
  }

  function lireTexte(texte, imposees = null) {
    const tout = String(texte ?? '').replace(/\r\n?/g, '\n');
    const lignes = lignesCSV(tout);
    const sep = separateurDominant(lignes);
    if (sep) return lireTableau(lignes.filter(l => l.trim()).map(l => decouperCSV(l, sep)), imposees);

    // Paragraphes séparés par des lignes vides. Chacun est soit la fiche d'un
    // client (nom, adresse, téléphone, consignes sur plusieurs lignes), soit
    // une liste « un client par ligne ».
    const blocs = [];
    let courant = [];
    for (const l of lignes.map(x => x.trim())) {
      if (!l) { if (courant.length) blocs.push(courant); courant = []; } else courant.push(l);
    }
    if (courant.length) blocs.push(courant);
    const arrets = [];
    const fiches = blocs.filter(b => !estListe(b)).length;
    const listes = blocs.length - fiches;
    for (const b of blocs) {
      if (!estListe(b)) { arrets.push(lireBloc(b.map(sansNumeroListe))); continue; }
      const lus = b.map(lireLigne);
      // Document en fiches (bons de livraison, mail) : une ligne isolée sans
      // adresse ni téléphone est un titre, pas un client.
      arrets.push(...(fiches && b.length === 1 ? lus.filter(a => a.adresse || a.telephone) : lus));
    }
    return { arrets: arrets.filter(a => a.nom || a.adresse), forme: fiches >= listes ? 'blocs' : 'lignes' };
  }

  // Une ligne « complète » porte un nom puis une adresse : « Bar X 12 rue Y 31000 Toulouse ».
  function ligneComplete(l) {
    const t = sansEtiquette(sansNumeroListe(l));
    const m = t.match(RE_NUMERO_VOIE);
    return RE_CP.test(t) && !!m && m.index > 2;
  }
  function estListe(b) {
    if (b.length === 1) return true;
    return b.length > 6 || b.filter(l => RE_CP.test(l)).length >= 2 || b.some(ligneComplete);
  }

  // --- Fichiers ------------------------------------------------------------------
  const CDN_XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const CDN_PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const CDN_PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  function chargerScript(src, quoi) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok;
      s.onerror = () => ko(new Error(`lecteur ${quoi} inaccessible (connexion internet ?)`));
      document.head.appendChild(s);
    });
  }

  // Excel exporté en CSV par un poste Windows : souvent en Windows-1252.
  async function texteDuFichier(f) {
    const buf = await f.arrayBuffer();
    let t = new TextDecoder('utf-8').decode(buf);
    if (t.includes('�')) t = new TextDecoder('windows-1252').decode(buf);
    return t.replace(/^﻿/, '');
  }

  // PDF : on reconstitue lignes et colonnes à partir des positions du texte.
  // Un grand écart horizontal devient une tabulation (colonne de tableau), un
  // grand écart vertical une ligne vide (nouveau bloc client).
  async function textePDF(f) {
    if (!racine.pdfjsLib) {
      await chargerScript(CDN_PDFJS, 'PDF');
      racine.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDFJS_WORKER;
    }
    const doc = await racine.pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
    const sortie = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const items = (await (await doc.getPage(n)).getTextContent()).items.filter(i => i.str.trim());
      const bandes = new Map();
      for (const i of items) {
        const y = Math.round(i.transform[5] / 3);
        if (!bandes.has(y)) bandes.set(y, []);
        bandes.get(y).push({ x: i.transform[4], w: i.width ?? 0, h: Math.abs(i.transform[3]) || 10, t: i.str });
      }
      const ys = [...bandes.keys()].sort((a, b) => b - a);
      const hauteurs = ys.map(y => Math.max(...bandes.get(y).map(f => f.h)));
      const hMed = hauteurs.slice().sort((a, b) => a - b)[Math.floor(hauteurs.length / 2)] || 10;
      let yPrec = null;
      for (const y of ys) {
        if (yPrec !== null && (yPrec - y) * 3 > hMed * 1.9) sortie.push('');
        const fs = bandes.get(y).sort((a, b) => a.x - b.x);
        let l = '', fin = null;
        for (const fr of fs) {
          if (fin !== null) l += fr.x - fin > hMed * 1.5 ? '\t' : (fr.x - fin > hMed * 0.15 ? ' ' : '');
          l += fr.t; fin = fr.x + fr.w;
        }
        sortie.push(l.trim());
        yPrec = y;
      }
      sortie.push('');
    }
    return sortie.join('\n');
  }

  /** Lit un fichier → { feuilles?: [{nom, lignes}], texte?: string } */
  async function lireFichier(f) {
    const nom = f.name.toLowerCase();
    if (/\.(xlsx|xlsm|xls|ods)$/.test(nom)) {
      if (!racine.XLSX) await chargerScript(CDN_XLSX, 'Excel');
      const classeur = racine.XLSX.read(await f.arrayBuffer(), { type: 'array', dateNF: 'dd/mm/yyyy' });
      const feuilles = classeur.SheetNames.map(n => ({
        nom: n, lignes: racine.XLSX.utils.sheet_to_json(classeur.Sheets[n], { header: 1, raw: false, defval: '' }),
      })).filter(fe => fe.lignes.some(r => r.some(c => String(c).trim())));
      if (!feuilles.length) throw new Error('le classeur est vide');
      return { feuilles };
    }
    if (/\.pdf$/.test(nom) || f.type === 'application/pdf') {
      const texte = await textePDF(f);
      if (!texte.trim()) throw new Error('aucun texte dans ce PDF (document scanné ?) : copiez-collez la liste à la place');
      return { texte };
    }
    return { texte: await texteDuFichier(f) };
  }

  const api = { lireTexte, lireTableau, lireFichier, controleForme, formaterTel, telEnLien, CHAMPS, RE_TEL };
  racine.TourneesImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
