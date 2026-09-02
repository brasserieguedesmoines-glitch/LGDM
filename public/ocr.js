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

function chargerScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error('moteur de lecture inaccessible (connexion ?)'));
    document.head.appendChild(s);
  });
}

// Prépare l'image pour l'OCR : on garde une résolution confortable (le texte
// d'une capture est petit) et on évite la compression JPEG qui abîme les bords
// des caractères.
async function imagePourOCR(fichier, maxPx = 2200) {
  const bmp = await createImageBitmap(fichier);
  const ratio = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * ratio);
  cv.height = Math.round(bmp.height * ratio);
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv;
}

async function lireImageOCR(fichier, surAvancement = () => {}) {
  if (!window.Tesseract) {
    surAvancement('Téléchargement du moteur de lecture…', null);
    await chargerScript(CDN_TESSERACT);
  }
  const canvas = await imagePourOCR(fichier);
  const res = await Tesseract.recognize(canvas, 'fra', {
    logger: m => {
      if (m.status === 'recognizing text') surAvancement('Lecture du texte…', m.progress);
      else if (m.status.startsWith('loading') || m.status.startsWith('initial')) surAvancement('Préparation du moteur…', null);
    },
  });
  return res.data.text ?? '';
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

// Contenance évoquée par un texte : 0.33, 0.75, ou 'fut'
function contenanceDe(txt) {
  const t = sansAccent(txt);
  if (/f[uû]t|keg|\b(20|30)\s*l\b/.test(t)) return 'fut';
  if (/\b0?[.,]?33\b|\b33\s*cl\b/.test(t)) return '33';
  if (/\b0?[.,]?75\b|\b75\s*cl\b/.test(t)) return '75';
  return null;
}

// Quantité exprimée sur une ligne, colisage compris.
// Renvoie null si la ligne ne porte aucun nombre exploitable.
function quantiteDe(ligne) {
  // On neutralise d'abord les nombres qui désignent la contenance, pour ne pas
  // prendre « 33 » de « Blonde 33 cl » pour une quantité.
  const t = sansAccent(ligne).replace(/\b0?[.,]?(33|75)\s*(cl)?\b/g, ' ').replace(/\b(20|30)\s*l\b/g, ' ');

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

  const resultats = [];
  const dejaPris = new Set();

  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.trim();
    if (ligne.length < 3 || !/\d/.test(ligne)) continue;

    const quantite = quantiteDe(ligne);
    if (!quantite || quantite < 1 || quantite > 10000) continue;

    const motsLigne = motsDe(ligne);
    const contLigne = contenanceDe(ligne);

    let meilleur = null, meilleurScore = 0;
    for (const f of fiches) {
      if (!f.mots.length) continue;
      const touches = f.mots.filter(m => motsLigne.some(x => proche(x, m))).length;
      let score = touches / f.mots.length;
      if (!score) continue;
      if (contLigne && f.contenance) score += contLigne === f.contenance ? 0.35 : -0.6;
      if (dejaPris.has(f.index)) score -= 0.15;   // évite de tout coller sur la même référence
      if (score > meilleurScore) { meilleurScore = score; meilleur = f; }
    }

    const trouve = meilleurScore >= 0.5 ? meilleur : null;
    if (trouve) dejaPris.add(trouve.index);
    resultats.push({
      index: trouve ? trouve.index : null,
      libelleLu: ligne.slice(0, 120),
      quantite,
    });
  }
  return resultats;
}

window.lireImageOCR = lireImageOCR;
window.analyserTexteOCR = analyserTexteOCR;
