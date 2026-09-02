// Lecture d'une commande sur image, entièrement dans le navigateur.
//
// Aucun serveur, aucune clé, aucun coût : le moteur Tesseract est téléchargé
// depuis un CDN au premier usage (puis mis en cache par le navigateur), lit le
// texte de l'image, et les lignes sont rapprochées du tarif du client ici même.
//
// Conçu pour les captures d'écran (SMS, WhatsApp, mail, tableur) et les textes
// imprimés. L'écriture manuscrite reste mal reconnue : c'est la limite assumée
// de l'OCR classique face à un modèle de vision.

const CDN_TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const CDN_PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const CDN_PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

function chargerScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error('moteur de lecture inaccessible (connexion ?)'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// PDF : extraction du texte réel, sans OCR
// ---------------------------------------------------------------------------
// Les bons de commande fournisseurs (GMS notamment) sont des PDF générés : ils
// contiennent déjà leur texte. L'extraire donne un résultat exact, instantané
// et gratuit, là où l'OCR d'une capture du même document perd des cellules.

async function lirePDF(fichier, surAvancement = () => {}) {
  if (!window.pdfjsLib) {
    surAvancement('Préparation du lecteur PDF…', null);
    await chargerScript(CDN_PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDFJS_WORKER;
  }
  const doc = await pdfjsLib.getDocument({ data: await fichier.arrayBuffer() }).promise;
  const lignes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    surAvancement(`Lecture de la page ${n} sur ${doc.numPages}…`, n / doc.numPages);
    const contenu = await (await doc.getPage(n)).getTextContent();
    // Les fragments d'un PDF ne sont pas ordonnés en lignes : on les regroupe
    // par position verticale, puis on les ordonne de gauche à droite. C'est ce
    // qui reconstitue correctement les lignes d'un tableau.
    const frags = contenu.items
      .filter(i => i.str.trim())
      .map(i => ({ x: i.transform[4], y: Math.round(i.transform[5]), t: i.str }));
    const bandes = new Map();
    for (const f of frags) {
      const cle = Math.round(f.y / 4);   // tolérance de 4 pt sur la ligne de base
      if (!bandes.has(cle)) bandes.set(cle, []);
      bandes.get(cle).push(f);
    }
    [...bandes.entries()]
      .sort((a, b) => b[0] - a[0])       // haut de page en premier
      .forEach(([, fs]) => lignes.push(fs.sort((a, b) => a.x - b.x).map(f => f.t).join(' ')));
  }
  return lignes.join('\n');
}

// ---------------------------------------------------------------------------
// Image : OCR
// ---------------------------------------------------------------------------
// Deux traitements font toute la différence sur une capture d'écran : agrandir
// (le texte d'un écran est trop petit pour Tesseract, qui vise du 300 dpi) et
// forcer le contraste en noir et blanc.
async function imagePourOCR(fichier, cible = 2400) {
  const bmp = await createImageBitmap(fichier);
  const grand = Math.max(bmp.width, bmp.height);
  const echelle = Math.min(3, Math.max(1, cible / grand));   // agrandit, jamais au-delà de ×3
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * echelle);
  cv.height = Math.round(bmp.height * echelle);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);

  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const v = g < 140 ? 0 : g > 190 ? 255 : Math.round((g - 140) / 50 * 255);
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

async function lireImageOCR(fichier, surAvancement = () => {}) {
  if (/pdf/i.test(fichier.type) || /\.pdf$/i.test(fichier.name ?? '')) {
    return lirePDF(fichier, surAvancement);
  }
  if (!window.Tesseract) {
    surAvancement('Téléchargement du moteur de lecture…', null);
    await chargerScript(CDN_TESSERACT);
  }
  const canvas = await imagePourOCR(fichier);
  const worker = await Tesseract.createWorker('fra', 1, {
    logger: m => {
      if (m.status === 'recognizing text') surAvancement('Lecture du texte…', m.progress);
      else if (m.status.startsWith('loading') || m.status.startsWith('initial')) surAvancement('Préparation du moteur…', null);
    },
  });
  try {
    // PSM 6 (« bloc de texte homogène ») retient bien mieux les colonnes de
    // chiffres qu'une segmentation automatique sur un document structuré.
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const res = await worker.recognize(canvas);
    return res.data.text ?? '';
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Rapprochement du texte lu avec le tarif du client
// ---------------------------------------------------------------------------

const sansAccent = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const motsDe = s => sansAccent(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Distance de Levenshtein bornée : tolère les confusions courantes de l'OCR
// (rn/m, 0/o, 1/l) sur les mots un peu longs.
function proche(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 4) return false;
  let d = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}

// Contenance évoquée par un texte : 0.33, 0.75, ou 'fut'.
// Tolère « 0.33L », « 33 cl », « Bouteille - 0.75L » ; ignore les suites de
// chiffres d'un code-barres (le nombre doit être isolé, pas noyé dans un EAN).
function contenanceDe(txt) {
  const t = sansAccent(txt);
  if (/f[uû]t|keg|(^|\D)(20|30)\s*l(\D|$)/.test(t)) return 'fut';
  if (/(^|\D)0?[.,]?33\s*(cl|l)?(\D|$)/.test(t)) return '33';
  if (/(^|\D)0?[.,]?75\s*(cl|l)?(\D|$)/.test(t)) return '75';
  return null;
}

// Codes-barres EAN13 présents dans un texte.
// On découpe en mots plutôt que d'utiliser une expression gourmande : sur
// « 3770005751098 1,90 1 24 45,60 », une regex avale le « 1 » suivant et
// produit 14 chiffres, donc plus aucun code ne correspond.
function eansDe(txt) {
  return String(txt).split(/\s+/)
    .map(t => t.replace(/\D/g, ''))
    .filter(d => d.length === 13);
}

// Nombre de chiffres différents entre deux codes de même longueur, borné.
// L'OCR confond volontiers 5/6, 0/8, 1/7 : deux écarts restent identifiables
// sans risque sur un code à 13 chiffres.
function ecartCode(a, b) {
  if (a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 2) return 99;
  return d;
}

// Prix décimaux d'une ligne (1,90 · 45,60 · 3.80)
const prixDe = txt => [...String(txt).matchAll(/(?<![\d.,])(\d{1,5})[.,](\d{2})(?![\d.,])/g)]
  .map(m => +(m[1] + '.' + m[2]));

// Quantité déduite des prix d'une ligne de tableau : total ÷ prix unitaire.
// C'est la méthode la plus fiable sur un bon de commande fournisseur, où les
// colonnes « nb de multiples » et « UVC » sont ambiguës mais où le total l'est
// jamais : 45,60 ÷ 1,90 = 24 bouteilles.
function quantiteParPrix(txt) {
  const prix = prixDe(txt);
  if (prix.length < 2) return null;
  const unitaire = Math.min(...prix), total = Math.max(...prix);
  if (unitaire <= 0 || total <= unitaire) return null;
  const q = total / unitaire, arrondi = Math.round(q);
  return arrondi >= 1 && arrondi <= 2000 && Math.abs(q - arrondi) < 0.02 ? arrondi : null;
}

// Quantité exprimée sur une ligne, colisage compris.
// Renvoie null si la ligne ne porte aucun nombre exploitable.
function quantiteDe(ligne) {
  // On neutralise d'abord ce qui n'est pas une quantité : codes-barres, prix
  // décimaux, puis les nombres qui désignent la contenance — sinon le « 33 »
  // de « Blonde 33 cl » ou le « 60 » de « 45,60 » passeraient pour des quantités.
  const t = sansAccent(ligne)
    .replace(/\d[\d\s]{11,20}\d/g, ' ')
    .replace(/(?<![\d.,])\d{1,5}[.,]\d{2}(?![\d.,])/g, ' ')
    .replace(/(^|\D)0?[.,]?(33|75)\s*(cl|l)?(?=\D|$)/g, '$1 ')
    .replace(/(^|\D)(20|30)\s*l(?=\D|$)/g, '$1 ');

  let m = t.match(/(\d+)\s*(?:cartons?|packs?|colis|caisses?)\s*(?:de|d'|[x*×])?\s*(\d+)/);
  if (m) return +m[1] * +m[2];

  m = t.match(/(\d+)\s*[x*×]\s*(\d+)/);
  if (m) return +m[1] * +m[2];

  m = t.match(/[x*×]\s*(\d+)/);
  if (m) return +m[1];

  m = t.match(/(\d+)\s*(?:bouteilles?|btl|bt\b|unites?|pieces?|f[uû]ts?)/);
  if (m) return +m[1];

  // Dernier recours : le dernier entier isolé de la ligne
  const nombres = t.match(/\b\d{1,4}\b/g);
  return nombres ? +nombres[nombres.length - 1] : null;
}

/**
 * Rapproche le texte OCR du catalogue.
 * @param {string} texte      texte brut renvoyé par l'OCR
 * @param {Array}  catalogue  [{ libelle, contenant }, …] dans l'ordre d'origine
 * @returns {Array} [{ index|null, libelleLu, quantite }]
 */
function analyserTexteOCR(texte, catalogue) {
  // Mots présents dans presque toutes les références (« gué », « des »,
  // « moines »…) : ils ne distinguent rien, on les ignore dans le score.
  const freq = new Map();
  catalogue.forEach(p => new Set(motsDe(p.libelle)).forEach(m => freq.set(m, (freq.get(m) ?? 0) + 1)));
  const distinctifs = p => motsDe(p.libelle).filter(m => m.length > 2 && freq.get(m) < catalogue.length * 0.8);

  const fiches = catalogue.map((p, index) => ({
    index,
    mots: distinctifs(p),
    contenance: contenanceDe(p.contenant) ?? contenanceDe(p.libelle),
  }));

  // Index des codes-barres : sur un bon fournisseur, l'EAN13 identifie la
  // référence sans ambiguïté — c'est le seul moyen de distinguer une IPA 33 cL
  // d'une IPA 75 cL quand le libellé imprimé ne mentionne pas la contenance.
  const parEan = new Map();
  catalogue.forEach((p, i) => {
    const g = String(p.gtin ?? '').replace(/\D/g, '');
    if (g.length === 13 && !parEan.has(g)) parEan.set(g, i);
  });

  // Lignes de totaux et d'en-tête : elles portent des prix mais aucun produit
  const ignorable = l => /\btotaux?\b|\bfournisseur\b|\brayon\b|\bt\.?v\.?a\b|\blibell|\bean\s?13\b|\bquantite\b/.test(sansAccent(l));

  const lignes = texte.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const resultats = [];
  const dejaPris = new Set();

  // Rapproche un texte du catalogue : code-barres d'abord, puis les mots.
  function rapprocher(txt) {
    const codes = eansDe(txt);
    for (const ean of codes) {
      if (parEan.has(ean)) return { index: parEan.get(ean), sur: true, score: 1 };
    }
    // Code lu de travers : on accepte deux chiffres d'écart, sans ambiguïté
    for (const ean of codes) {
      const candidats = [...parEan.keys()].filter(k => ecartCode(k, ean) <= 2);
      if (candidats.length === 1) return { index: parEan.get(candidats[0]), sur: true, score: 1 };
    }
    const mots = motsDe(txt);
    const cont = contenanceDe(txt);
    let meilleur = null, meilleurScore = 0;
    for (const f of fiches) {
      if (!f.mots.length) continue;
      const touches = f.mots.filter(m => mots.some(x => proche(x, m))).length;
      let score = touches / f.mots.length;
      if (!score) continue;
      if (cont && f.contenance) score += cont === f.contenance ? 0.35 : -0.6;
      if (dejaPris.has(f.index)) score -= 0.15;   // évite de tout coller sur la même référence
      if (score > meilleurScore) { meilleurScore = score; meilleur = f; }
    }
    return meilleurScore >= 0.5
      ? { index: meilleur.index, sur: false, score: meilleurScore }
      : { index: null, sur: false, score: meilleurScore, ean: codes.length > 0 };
  }

  // Sur un tableau, une même ligne de commande est souvent éclatée en deux ou
  // trois lignes de texte (libellé sur deux lignes, code-barres en dessous).
  // On élargit donc la fenêtre jusqu'à obtenir à la fois un produit et une
  // quantité, sans jamais dépasser trois lignes pour ne pas fusionner deux
  // références voisines.
  const MAX_FENETRE = 3;
  for (let i = 0; i < lignes.length; i++) {
    if (ignorable(lignes[i])) continue;
    let pris = null;

    for (let n = 1; n <= MAX_FENETRE && i + n <= lignes.length; n++) {
      const bloc = lignes.slice(i, i + n);
      if (n > 1 && ignorable(bloc[n - 1])) break;
      const txt = bloc.join(' ');
      const quantite = quantiteParPrix(txt) ?? quantiteDe(txt);
      if (!quantite || quantite < 1 || quantite > 10000) continue;
      const trouve = rapprocher(txt);
      if (trouve.index === null && n < MAX_FENETRE) continue;   // laisse une chance aux lignes suivantes
      pris = { trouve, quantite, txt, n };
      break;
    }

    if (!pris) continue;
    // Une ligne sans le moindre mot de produit ni code-barres n'est pas une
    // ligne de commande (adresse, numéro de bon, date) : inutile de la
    // signaler comme « non reconnue », cela noierait les vraies anomalies.
    if (pris.trouve.index === null && !pris.trouve.score && !pris.trouve.ean) continue;

    if (pris.trouve.index !== null) dejaPris.add(pris.trouve.index);
    resultats.push({
      index: pris.trouve.index,
      certain: pris.trouve.sur,
      libelleLu: pris.txt.slice(0, 120),
      quantite: pris.quantite,
    });
    i += pris.n - 1;
  }
  return resultats;
}

window.lireImageOCR = lireImageOCR;
window.analyserTexteOCR = analyserTexteOCR;
