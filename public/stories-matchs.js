// Stories Instagram des matchs diffusés au Gué des Moines.
//
// La page envoie la demande à l'agent (/api/stories/preparer), reçoit une
// proposition structurée (accroche, matchs, légende), la rend modifiable et la
// dessine sur un canevas 1080 × 1920 aux couleurs de la marque. Tout se fait
// dans le navigateur : l'image téléchargée est exactement celle de l'aperçu.

monterCoquille({ titre: 'Stories matchs', actif: '/stories.html' });

const $ = id => document.getElementById(id);
const CLE_BROUILLON = 'lgdm-story-brouillon';
const MAX_MATCHS = 6;

// ---------------------------------------------------------------------------
//  État
// ---------------------------------------------------------------------------
const matchVide = () => ({
  sport: 'rugby', competition: '', domicile: '', exterieur: '', date: '', heure: '',
  diffuseur: '', couleurDomicile: '', couleurExterieur: '',
  wikiDomicile: '', wikiExterieur: '',     // article Wikipédia d'où vient le logo
  logoDomicile: '', logoExterieur: '',     // '' = automatique, 'aucun', ou image ajoutée à la main
});
const storyVide = () => ({
  format: 'affiche', badge: 'DIFFUSION EN DIRECT', titre: 'CE WEEK-END AU GUÉ', sousTitre: '',
  matchs: [matchVide()], offre: 'Venez tôt, ça va être plein !', legende: '', logos: true,
});

let story = storyVide();
let photo = null;          // ImageBitmap / HTMLImageElement de la photo de fond (jamais stockée)
const logo = new Image();
logo.src = 'logo.png';

// --- Logos des équipes -------------------------------------------------------
// Par ordre de priorité : le logo ajouté à la main sur ce match, puis celui déjà
// ajouté pour une équipe du même nom (mémorisé sur l'appareil), enfin l'image de
// l'article Wikipédia indiqué par l'agent. À défaut, un médaillon aux initiales.
const CLE_LOGOS = 'lgdm-logos-equipes';
const SUFFIXE = { domicile: 'Domicile', exterieur: 'Exterieur' };
const normaliser = n => String(n ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let bibliotheque = {};
try { bibliotheque = JSON.parse(localStorage.getItem(CLE_LOGOS) || '{}') || {}; } catch {}

function retenirLogo(nom, dataUrl) {
  const cle = normaliser(nom);
  if (!cle) return;
  bibliotheque[cle] = dataUrl;
  try { localStorage.setItem(CLE_LOGOS, JSON.stringify(bibliotheque)); }
  catch { delete bibliotheque[cle]; }   // stockage plein : le logo reste sur ce match seulement
}

function sourceLogo(m, cote) {
  const manuel = m[`logo${SUFFIXE[cote]}`] || '';
  if (manuel === 'aucun') return null;
  if (manuel.startsWith('data:image/')) return manuel;
  const memorise = bibliotheque[normaliser(m[cote])];
  if (memorise) return memorise;
  const wiki = m[`wiki${SUFFIXE[cote]}`];
  return wiki ? `/api/stories/logo?page=${encodeURIComponent(wiki)}` : null;
}

const images = new Map();   // source → { img, ok: null (en cours) | true | false }
function etatLogo(source) {
  if (!source) return null;
  let e = images.get(source);
  if (!e) {
    e = { img: new Image(), ok: null };
    e.img.onload = () => { e.ok = true; redessiner(); };
    e.img.onerror = () => { e.ok = false; redessiner(); };
    e.img.src = source;
    images.set(source, e);
  }
  return e;
}
const imageLogo = (m, cote) => {
  if (story.logos === false) return null;
  const e = etatLogo(sourceLogo(m, cote));
  return e?.ok ? e.img : null;
};
/** Vrai si l'équipe a un logo affiché ou en cours de chargement. */
const aUnLogo = (m, cote) => {
  if (story.logos === false) return false;
  const e = etatLogo(sourceLogo(m, cote));
  return !!e && e.ok !== false;
};

function lireBrouillon() {
  try {
    const b = JSON.parse(localStorage.getItem(CLE_BROUILLON) || 'null');
    if (b && Array.isArray(b.matchs)) story = { ...storyVide(), ...b };
  } catch {}
}
function sauverBrouillon() {
  try { localStorage.setItem(CLE_BROUILLON, JSON.stringify(story)); } catch {}
}

// ---------------------------------------------------------------------------
//  Dessin de la story
// ---------------------------------------------------------------------------
const L = 1080, H = 1920;
const C = {
  fond: '#000000', carte: '#1A1714', carte2: '#201C18',
  ambre: '#F5A425', ambreFonce: '#F0921E', brun: '#5C3A17',
  blanc: '#FFFFFF', gris: '#A8A39A', surAmbre: '#1A1206',
};
const DISPLAY = '"Anton", "Bebas Neue", Impact, "Arial Narrow", sans-serif';
const TEXTE = '"Inter", system-ui, -apple-system, sans-serif';
// Zones masquées par Instagram (profil en haut, champ de réponse en bas) :
// rien d'important n'y est placé.
const HAUT_UTILE = 200, BAS_UTILE = 1680;

const canvas = $('story');
const ctx = canvas.getContext('2d');

function police(taille, famille = DISPLAY, graisse = '400') {
  ctx.font = `${graisse} ${Math.round(taille)}px ${famille}`;
}
function espacement(px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}
const largeurTexte = t => ctx.measureText(t).width;

/** Taille de police la plus grande (≤ max) pour que le texte tienne en largeur. */
function ajuster(txt, max, largeur, famille = DISPLAY, graisse = '400') {
  police(max, famille, graisse);
  const w = largeurTexte(txt);
  const t = w > largeur ? Math.max(18, Math.floor(max * largeur / w)) : max;
  police(t, famille, graisse);
  return t;
}

function rectArrondi(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Coupe un titre en 1 à 3 lignes équilibrées, à la plus grande taille possible. */
function couperTitre(titre, largeur, max) {
  const mots = titre.split(/\s+/).filter(Boolean);
  if (!mots.length) return { lignes: [], taille: max };
  police(max);
  const mesure = t => largeurTexte(t);
  const tailleDe = lignes => Math.min(max, Math.floor(max * largeur / Math.max(...lignes.map(mesure))));
  const candidats = [[mots.join(' ')]];
  for (let i = 1; i < mots.length; i++) candidats.push([mots.slice(0, i).join(' '), mots.slice(i).join(' ')]);
  for (let i = 1; i < mots.length; i++) {
    for (let j = i + 1; j < mots.length; j++) {
      candidats.push([mots.slice(0, i).join(' '), mots.slice(i, j).join(' '), mots.slice(j).join(' ')]);
    }
  }
  // Une ligne si elle reste grande ; sinon le découpage le plus équilibré.
  const seuils = { 1: max * 0.78, 2: max * 0.62, 3: 0 };
  for (const n of [1, 2, 3]) {
    const options = candidats.filter(c => c.length === n);
    if (!options.length) continue;
    const meilleur = options.reduce((a, b) => (tailleDe(b) > tailleDe(a) ? b : a));
    const t = tailleDe(meilleur);
    if (t >= seuils[n] || n === Math.min(3, mots.length)) return { lignes: meilleur, taille: Math.max(t, 60) };
  }
  return { lignes: [mots.join(' ')], taille: tailleDe([mots.join(' ')]) };
}

/** Coupe un texte courant sur plusieurs lignes (sous-titre). */
function couperTexte(txt, largeur, maxLignes) {
  // Espace insécable avant « ! ? : ; » : la ponctuation ne part jamais seule à la ligne
  const mots = txt.replace(/\s+([!?:;»])/g, '\u00A0$1').replace(/(«)\s+/g, '$1\u00A0').split(/ +/).filter(Boolean);
  const lignes = [];
  let courante = '';
  for (const m of mots) {
    const essai = courante ? `${courante} ${m}` : m;
    if (largeurTexte(essai) <= largeur || !courante) courante = essai;
    else { lignes.push(courante); courante = m; }
  }
  if (courante) lignes.push(courante);
  if (lignes.length > maxLignes) {
    lignes.length = maxLignes;
    lignes[maxLignes - 1] = lignes[maxLignes - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lignes;
}

const MOIS_COURTS = ['JANV.', 'FÉVR.', 'MARS', 'AVR.', 'MAI', 'JUIN', 'JUIL.', 'AOÛT', 'SEPT.', 'OCT.', 'NOV.', 'DÉC.'];
function jourMatch(iso, long) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (long) return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  const jour = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '').toUpperCase();
  return `${jour}. ${d.getDate()} ${MOIS_COURTS[d.getMonth()]}`;
}
const heureMatch = h => (/^\d{2}:\d{2}$/.test(h || '') ? h.replace(':', 'H') : '');
const nomEquipe = (n, defaut) => (n || defaut).toUpperCase();

function dessinerFond() {
  ctx.fillStyle = C.fond;
  ctx.fillRect(0, 0, L, H);
  if (!photo) return;
  // Recadrage « cover » puis voile noir : le texte reste lisible quelle que soit la photo.
  const pw = photo.width, ph = photo.height;
  const e = Math.max(L / pw, H / ph);
  ctx.drawImage(photo, (L - pw * e) / 2, (H - ph * e) / 2, pw * e, ph * e);
  const voile = ctx.createLinearGradient(0, 0, 0, H);
  voile.addColorStop(0, 'rgba(0,0,0,0.72)');
  voile.addColorStop(0.35, 'rgba(0,0,0,0.86)');
  voile.addColorStop(1, 'rgba(0,0,0,0.95)');
  ctx.fillStyle = voile;
  ctx.fillRect(0, 0, L, H);
}

/** Logo, nom de la maison et badge pilule. Renvoie l'ordonnée sous l'en-tête.
 *  Avec trace = false, ne dessine rien : sert à mesurer avant de choisir la mise en page. */
function dessinerEntete(compact, trace = true) {
  const hLogo = compact ? 104 : 140;
  const yLogo = HAUT_UTILE + (compact ? 0 : 10);
  if (trace && logo.complete && logo.naturalWidth) {
    const wLogo = hLogo * logo.naturalWidth / logo.naturalHeight;
    ctx.drawImage(logo, (L - wLogo) / 2, yLogo, wLogo, hLogo);
  }
  let y = yLogo + hLogo + (compact ? 50 : 62);
  if (trace) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.gris;
    police(compact ? 24 : 27, TEXTE, '600');
    espacement(7);
    ctx.fillText('LE GUÉ DES MOINES · BRUGUIÈRES', L / 2, y);
    espacement(0);
  }

  const badge = (story.badge || '').trim().toUpperCase();
  y += compact ? 34 : 42;
  if (badge) {
    const h = compact ? 60 : 68;
    if (trace) {
      police(compact ? 25 : 28, TEXTE, '700');
      espacement(5);
      const w = largeurTexte(badge) + 34 + 70;
      const x = (L - w) / 2;
      rectArrondi(x, y, w, h, h / 2);
      ctx.fillStyle = 'rgba(245,164,37,0.08)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = C.brun;
      ctx.stroke();
      ctx.fillStyle = C.ambre;
      ctx.beginPath(); ctx.arc(x + 38, y + h / 2, 7, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, x + 62, y + h / 2 + 2);
      espacement(0);
    }
    y += h;
  }
  return y;
}

/** Hauteur et dessin de l'accroche + sous-titre. */
function mesurerTitre(maxTaille) {
  const titre = (story.titre || '').trim().toUpperCase();
  const t = couperTitre(titre, 960, maxTaille);
  police(40, TEXTE, '500');
  const sous = story.sousTitre ? couperTexte(story.sousTitre.trim(), 920, 2) : [];
  const hTitre = t.lignes.length * t.taille * 1.04;
  return { ...t, sous, hauteur: hTitre + (sous.length ? 26 + sous.length * 52 : 0) };
}
function dessinerTitre(m, y) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  police(m.taille);
  m.lignes.forEach((ligne, i) => {
    // Dernière ligne en ambre quand l'accroche tient sur plusieurs lignes
    ctx.fillStyle = m.lignes.length > 1 && i === m.lignes.length - 1 ? C.ambre : C.blanc;
    ctx.fillText(ligne, L / 2, y + i * m.taille * 1.04);
  });
  let yy = y + m.lignes.length * m.taille * 1.04;
  if (m.sous.length) {
    yy += 26;
    police(40, TEXTE, '500');
    ctx.fillStyle = C.gris;
    m.sous.forEach((l, i) => ctx.fillText(l, L / 2, yy + i * 52));
    yy += m.sous.length * 52;
  }
  return yy;
}

function dessinerBouton(yCentre) {
  const offre = (story.offre || '').trim().toUpperCase();
  if (!offre) return;
  const h = 98;
  const taille = ajuster(offre, 38, 800, TEXTE, '800');
  espacement(1);
  const w = Math.min(960, largeurTexte(offre) + 120);
  const x = (L - w) / 2, y = yCentre - h / 2;
  ctx.shadowColor = 'rgba(245,164,37,0.35)';
  ctx.shadowBlur = 40;
  rectArrondi(x, y, w, h, h / 2);
  ctx.fillStyle = C.ambre;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = C.surAmbre;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  police(taille, TEXTE, '800');
  ctx.fillText(offre, L / 2, y + h / 2 + 2);
  espacement(0);
}

function carte(x, y, w, h, r = 36) {
  rectArrondi(x, y, w, h, r);
  ctx.fillStyle = 'rgba(26,23,20,0.92)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();
}

function marqueEquipe(couleur, x, y, w, h) {
  if (!couleur) return;
  rectArrondi(x, y, w, h, Math.min(w, h) / 2);
  ctx.fillStyle = couleur;
  ctx.fill();
  // Liseré clair : une couleur sombre (noir, bleu nuit) reste visible sur le fond
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
}

function initiales(nom) {
  const mots = nom.split(/[\s-]+/).filter(m => m && !/^(de|du|des|d'|l'|et)$/i.test(m));
  if (!mots.length) return '?';
  return (mots.length === 1 ? mots[0].slice(0, 2) : mots[0][0] + mots[1][0]).toUpperCase();
}
function couleurClaire(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return false;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 165;
}

/** Logo de l'équipe dans un carré de côté t centré en (cx, cy) ; à défaut, médaillon aux initiales. */
function dessinerBlason(m, cote, cx, cy, t) {
  const img = imageLogo(m, cote);
  ctx.save();
  if (img) {
    const e = Math.min(t / img.naturalWidth, t / img.naturalHeight);
    const w = img.naturalWidth * e, h = img.naturalHeight * e;
    // Halo clair : les parties sombres d'un logo (noir, bleu marine) restent lisibles sur le noir
    ctx.shadowColor = 'rgba(255,255,255,0.32)';
    ctx.shadowBlur = Math.max(8, t * 0.1);
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    const couleur = m[`couleur${SUFFIXE[cote]}`];
    const r = t * 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = couleur || '#2A2622';
    ctx.fill();
    ctx.lineWidth = Math.max(2, t * 0.012);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();
    const txt = initiales(nomEquipe(m[cote], cote === 'domicile' ? 'Équipe 1' : 'Équipe 2'));
    ctx.fillStyle = couleurClaire(couleur) ? '#111111' : C.blanc;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ajuster(txt, r * 0.95, r * 1.4);
    ctx.fillText(txt, cx, cy + r * 0.05);
  }
  ctx.restore();
}

/** Nom d'équipe sur une ou deux lignes, à la plus grande taille possible. */
function couperNom(nom, largeur, max) {
  police(max);
  const une = Math.min(max, Math.floor(max * largeur / largeurTexte(nom)));
  const mots = nom.split(/\s+/);
  if (une >= max * 0.8 || mots.length < 2) return { lignes: [nom], taille: une };
  let meilleur = null;
  for (let i = 1; i < mots.length; i++) {
    const l = [mots.slice(0, i).join(' '), mots.slice(i).join(' ')];
    const t = Math.min(max, Math.floor(max * largeur / Math.max(...l.map(largeurTexte))));
    if (!meilleur || t > meilleur.taille) meilleur = { lignes: l, taille: t };
  }
  return meilleur.taille > une ? meilleur : { lignes: [nom], taille: une };
}

// --- Mise en page « Affiche » : un seul match, en grand ----------------------
function dessinerAffiche() {
  const m = story.matchs[0] ?? matchVide();
  // Avec au moins un logo : les deux blasons face à face. Sinon, noms empilés.
  const faceAFace = aUnLogo(m, 'domicile') || aUnLogo(m, 'exterieur');
  const hCarte = faceAFace ? 690 : 620, hBouton = story.offre ? 98 : 0;
  // Du plus aéré au plus serré : on garde la première mise en page qui tient
  // au-dessus de la zone masquée par Instagram (accroche longue, sous-titre sur deux lignes…).
  const essais = [
    { compact: false, tMax: 150, ecart: 60 },
    { compact: false, tMax: 126, ecart: 44 },
    { compact: true, tMax: 120, ecart: 36 },
    { compact: true, tMax: 100, ecart: 28 },
  ];
  let choix, titre, zoneHaut, total;
  for (choix of essais) {
    zoneHaut = dessinerEntete(choix.compact, false) + (choix.compact ? 40 : 56);
    titre = mesurerTitre(choix.tMax);
    total = titre.hauteur + choix.ecart + hCarte + (hBouton ? choix.ecart + hBouton : 0);
    if (zoneHaut + total <= BAS_UTILE) break;
  }
  dessinerEntete(choix.compact);
  let y = zoneHaut + Math.max(0, (BAS_UTILE - zoneHaut - total) / 2);
  y = dessinerTitre(titre, y) + choix.ecart;

  // Carte du match
  const x = 60, w = L - 120;
  carte(x, y, w, hCarte);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  if (m.competition) {
    ctx.fillStyle = C.ambre;
    espacement(5);
    ajuster(m.competition.toUpperCase(), 30, w - 120, TEXTE, '700');
    ctx.fillText(m.competition.toUpperCase(), L / 2, y + 74);
    espacement(0);
  }
  if (faceAFace) {
    const cy = y + 258, t = 250, dx = 240;
    dessinerBlason(m, 'domicile', L / 2 - dx, cy, t);
    dessinerBlason(m, 'exterieur', L / 2 + dx, cy, t);
    police(96);
    ctx.fillStyle = C.ambre;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', L / 2, cy + 6);
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.blanc;
    for (const [cote, cx, defaut] of [['domicile', L / 2 - dx, 'Équipe 1'], ['exterieur', L / 2 + dx, 'Équipe 2']]) {
      const { lignes, taille } = couperNom(nomEquipe(m[cote], defaut), 400, 58);
      police(taille);
      lignes.forEach((l, i) => ctx.fillText(l, cx, y + 412 + i * taille * 1.04));
    }
    ctx.textBaseline = 'alphabetic';
  } else {
    const yA = y + 200, yB = y + 404;
    for (const [nom, couleur, yy] of [
      [nomEquipe(m.domicile, 'Équipe 1'), m.couleurDomicile, yA],
      [nomEquipe(m.exterieur, 'Équipe 2'), m.couleurExterieur, yB],
    ]) {
      ajuster(nom, 112, w - 140);
      ctx.fillStyle = C.blanc;
      ctx.fillText(nom, L / 2, yy);
      marqueEquipe(couleur, L / 2 - 50, yy + 18, 100, 10);
    }
    // « VS » entre les deux équipes, sous la couleur de la première
    const yVs = y + 292;
    ctx.strokeStyle = 'rgba(245,164,37,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 120, yVs - 21); ctx.lineTo(L / 2 - 60, yVs - 21); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L / 2 + 60, yVs - 21); ctx.lineTo(x + w - 120, yVs - 21); ctx.stroke();
    police(52);
    ctx.fillStyle = C.ambre;
    ctx.fillText('VS', L / 2, yVs);
  }

  // Bandeau date · coup d'envoi · chaîne (codes « cartes de stats » de la marque)
  const yBande = y + hCarte - 150;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(x + 40, yBande); ctx.lineTo(x + w - 40, yBande); ctx.stroke();
  const cellules = [
    { valeur: jourMatch(m.date) || 'DATE ?', legende: 'LE', couleur: C.blanc },
    { valeur: heureMatch(m.heure) || '--H--', legende: "COUP D'ENVOI", couleur: C.ambre },
    { valeur: (m.diffuseur || 'ÉCRAN GÉANT').toUpperCase(), legende: 'SUR', couleur: C.blanc },
  ];
  const wc = w / 3;
  cellules.forEach((c, i) => {
    const cx = x + wc * i + wc / 2;
    if (i) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(x + wc * i, yBande + 28); ctx.lineTo(x + wc * i, y + hCarte - 28); ctx.stroke();
    }
    ctx.fillStyle = c.couleur;
    ajuster(c.valeur, i === 1 ? 74 : 54, wc - 40);
    ctx.textBaseline = 'middle';
    ctx.fillText(c.valeur, cx, yBande + 66);
    ctx.fillStyle = C.gris;
    police(20, TEXTE, '600');
    espacement(3);
    ctx.fillText(c.legende, cx, yBande + 122);
    espacement(0);
    ctx.textBaseline = 'alphabetic';
  });

  if (hBouton) dessinerBouton(y + hCarte + choix.ecart + hBouton / 2);
}

// --- Mise en page « Programme » : 2 à 6 matchs -------------------------------
function dessinerProgramme() {
  const matchs = story.matchs.slice(0, MAX_MATCHS);
  const n = Math.max(1, matchs.length);
  const compact = n >= 4;
  let y = dessinerEntete(compact);
  const titre = mesurerTitre(compact ? 118 : 140);
  const hBouton = story.offre ? 98 : 0;
  const ecart = n >= 5 ? 16 : 22;
  const zoneHaut = y + (compact ? 40 : 56);
  const zoneBas = BAS_UTILE - (hBouton ? hBouton + 50 : 0);
  const dispo = zoneBas - zoneHaut - titre.hauteur - 50;
  const hLigne = Math.min(250, Math.floor((dispo - ecart * (n - 1)) / n));
  const total = titre.hauteur + 50 + n * hLigne + (n - 1) * ecart;
  y = zoneHaut + Math.max(0, (zoneBas - zoneHaut - total) / 2);
  y = dessinerTitre(titre, y) + 50;

  const x = 60, w = L - 120;
  matchs.forEach((m, i) => {
    const yy = y + i * (hLigne + ecart);
    carte(x, yy, w, hLigne, 30);
    const wGauche = 250;
    // Bloc date / heure
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const tHeure = Math.min(96, hLigne * 0.4);
    const tJour = Math.max(20, Math.min(30, hLigne * 0.13));
    const blocH = tJour + 12 + tHeure * 0.86;
    const yBloc = yy + (hLigne - blocH) / 2;
    ctx.fillStyle = C.gris;
    espacement(2);
    ajuster(jourMatch(m.date) || 'DATE ?', tJour, wGauche - 40, TEXTE, '700');
    ctx.textBaseline = 'top';
    ctx.fillText(jourMatch(m.date) || 'DATE ?', x + wGauche / 2, yBloc);
    espacement(0);
    ctx.fillStyle = C.ambre;
    ajuster(heureMatch(m.heure) || '--H--', tHeure, wGauche - 40);
    ctx.fillText(heureMatch(m.heure) || '--H--', x + wGauche / 2, yBloc + tJour + 12);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + wGauche, yy + 22); ctx.lineTo(x + wGauche, yy + hLigne - 22); ctx.stroke();

    // Bloc équipes
    const xd = x + wGauche + 36, wd = w - wGauche - 70;
    const infos = [m.competition, m.diffuseur].filter(Boolean).join('  ·  ').toUpperCase();
    const tInfos = Math.max(18, Math.min(24, hLigne * 0.1));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const a = nomEquipe(m.domicile, 'Équipe 1'), b = nomEquipe(m.exterieur, 'Équipe 2');
    const avecLogos = aUnLogo(m, 'domicile') || aUnLogo(m, 'exterieur');
    if (hLigne >= 190) {
      const tEq = Math.min(62, hLigne * 0.25);
      const pas = avecLogos ? tEq * 1.32 : tEq * 1.08;     // un logo a besoin d'un peu plus de hauteur
      const hBloc = pas * 2 + (infos ? 14 + tInfos : 0);
      let yd = yy + (hLigne - hBloc) / 2 + (pas - tEq) / 2;
      for (const [cote, nom, couleur] of [['domicile', a, m.couleurDomicile], ['exterieur', b, m.couleurExterieur]]) {
        let decalage = couleur ? 28 : 0;
        if (avecLogos) {
          const t = tEq * 1.2;
          dessinerBlason(m, cote, xd + t / 2, yd + tEq * 0.45, t);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          decalage = t + 20;
        } else {
          marqueEquipe(couleur, xd, yd + tEq * 0.12, 10, tEq * 0.78);
        }
        ctx.fillStyle = C.blanc;
        ajuster(nom, tEq, wd - decalage);
        ctx.fillText(nom, xd + decalage, yd);
        yd += pas;
      }
      yd -= (pas - tEq) / 2;
      if (infos) {
        ctx.fillStyle = C.gris;
        espacement(2);
        ajuster(infos, tInfos, wd, TEXTE, '600');
        ctx.fillText(infos, xd, yd + 14);
        espacement(0);
      }
    } else {
      const ligne = `${a} – ${b}`;
      const tEq = Math.min(54, hLigne * 0.36);
      const hBloc = tEq * 1.1 + (infos ? 10 + tInfos : 0);
      const yd = yy + (hLigne - hBloc) / 2;
      let wTexte = wd;
      if (avecLogos) {
        // Les deux logos côte à côte, au bout de la ligne
        const t = Math.min(hLigne * 0.66, 88);
        const cxB = x + w - 30 - t / 2, cxA = cxB - t - 12;
        dessinerBlason(m, 'domicile', cxA, yy + hLigne / 2, t);
        dessinerBlason(m, 'exterieur', cxB, yy + hLigne / 2, t);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        wTexte = wd - 2 * t - 40;
      }
      ctx.fillStyle = C.blanc;
      ajuster(ligne, tEq, wTexte);
      ctx.fillText(ligne, xd, yd);
      if (infos) {
        ctx.fillStyle = C.gris;
        espacement(2);
        ajuster(infos, tInfos, wTexte, TEXTE, '600');
        ctx.fillText(infos, xd, yd + tEq * 1.1 + 10);
        espacement(0);
      }
    }
  });

  if (hBouton) dessinerBouton(zoneBas + 50 + hBouton / 2);
}

function dessiner() {
  ctx.save();
  ctx.clearRect(0, 0, L, H);
  dessinerFond();
  if (story.format === 'programme') dessinerProgramme();
  else dessinerAffiche();
  ctx.restore();
}

let dessinPrevu = false;
function redessiner() {
  if (dessinPrevu) return;
  dessinPrevu = true;
  requestAnimationFrame(() => { dessinPrevu = false; dessiner(); });
}

// ---------------------------------------------------------------------------
//  Formulaire
// ---------------------------------------------------------------------------
const echap = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CHAMPS = { 'f-badge': 'badge', 'f-titre': 'titre', 'f-sous-titre': 'sousTitre', 'f-offre': 'offre', 'f-legende': 'legende' };

function majCompteurs() {
  document.querySelectorAll('.compteur').forEach(el => {
    const champ = $(el.dataset.pour);
    el.textContent = `${champ.value.length}/${champ.maxLength}`;
  });
}

function rendreFormat() {
  document.querySelectorAll('[data-format]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.format === story.format)));
  const n = story.matchs.length;
  $('aide-format').textContent = story.format === 'affiche'
    ? (n > 1 ? `L'affiche ne montre que le 1er match : passez en « Programme » pour afficher les ${n}.` : 'Un match mis en avant en grand.')
    : `Liste de ${Math.min(n, MAX_MATCHS)} match${n > 1 ? 's' : ''}${n > MAX_MATCHS ? ` (les ${MAX_MATCHS} premiers)` : ''}.`;
}

function rendreChamps() {
  for (const [id, cle] of Object.entries(CHAMPS)) $(id).value = story[cle] ?? '';
  $('f-logos').checked = story.logos !== false;
  majCompteurs();
  rendreFormat();
  rendreMatchs();
}

function htmlLogo(m, i, cote) {
  const src = story.logos === false ? null : sourceLogo(m, cote);
  const introuvable = src && images.get(src)?.ok === false;
  const qui = cote === 'domicile' ? 'à domicile' : "à l'extérieur";
  const titre = introuvable ? 'Logo introuvable : touchez pour en ajouter un' : src ? 'Changer le logo' : 'Ajouter un logo';
  return `<span class="logo-case" data-i="${i}" data-cote="${cote}">
      <label class="logo-btn${introuvable ? ' introuvable' : ''}" title="${titre}">
        ${src && !introuvable
          ? `<img src="${echap(src)}" alt="Logo de l'équipe ${qui}">`
          : `<svg class="ico" aria-hidden="true"><use href="#i-photo"/></svg><span class="sr-only">${titre} (équipe ${qui})</span>`}
        <input type="file" accept="image/*" data-logo="${cote}" hidden>
      </label>
      ${src ? `<button type="button" class="logo-retirer" data-action="sans-logo" data-cote="${cote}" aria-label="Retirer le logo de l'équipe ${qui}">×</button>` : ''}
    </span>`;
}
function majLogo(i, cote) {
  const el = document.querySelector(`.logo-case[data-i="${i}"][data-cote="${cote}"]`);
  if (el && story.matchs[i]) el.outerHTML = htmlLogo(story.matchs[i], i, cote);
}

function rendreMatchs() {
  const conteneur = $('matchs');
  conteneur.innerHTML = story.matchs.map((m, i) => `
    <div class="match" data-i="${i}">
      <div class="match-tete">
        <span class="num">${i + 1}</span> Match ${i + 1}
        <button class="st-btn discret mini ordre" type="button" data-action="monter" ${i ? '' : 'disabled'} aria-label="Monter le match ${i + 1}">
          <svg class="ico" aria-hidden="true"><use href="#i-haut"/></svg></button>
        <button class="st-btn discret mini danger" type="button" data-action="suppr" ${story.matchs.length > 1 ? '' : 'disabled'} aria-label="Retirer le match ${i + 1}">
          <svg class="ico" aria-hidden="true"><use href="#i-corbeille"/></svg>Retirer</button>
      </div>
      <div class="equipes">
        <div class="champ"><label for="m${i}-dom">Domicile</label>
          <div class="equipe">${htmlLogo(m, i, 'domicile')}<input type="text" id="m${i}-dom" data-cle="domicile" maxlength="40" value="${echap(m.domicile)}" placeholder="Stade Toulousain">
          <input type="color" data-cle="couleurDomicile" value="${m.couleurDomicile || '#E30613'}" aria-label="Couleur de l'équipe à domicile"></div></div>
        <span class="vs">VS</span>
        <div class="champ"><label for="m${i}-ext">Extérieur</label>
          <div class="equipe">${htmlLogo(m, i, 'exterieur')}<input type="text" id="m${i}-ext" data-cle="exterieur" maxlength="40" value="${echap(m.exterieur)}" placeholder="La Rochelle">
          <input type="color" data-cle="couleurExterieur" value="${m.couleurExterieur || '#FFD100'}" aria-label="Couleur de l'équipe à l'extérieur"></div></div>
      </div>
      <div class="details">
        <div class="champ"><label for="m${i}-date">Date</label>
          <input type="date" id="m${i}-date" data-cle="date" value="${echap(m.date)}" class="${m.date ? '' : 'manque'}"></div>
        <div class="champ"><label for="m${i}-heure">Heure</label>
          <input type="time" id="m${i}-heure" data-cle="heure" value="${echap(m.heure)}" class="${m.heure ? '' : 'manque'}"></div>
        <div class="champ"><label for="m${i}-comp">Compétition</label>
          <input type="text" id="m${i}-comp" data-cle="competition" maxlength="50" value="${echap(m.competition)}" placeholder="Top 14 · 10e journée"></div>
        <div class="champ"><label for="m${i}-tv">Chaîne</label>
          <input type="text" id="m${i}-tv" data-cle="diffuseur" maxlength="30" value="${echap(m.diffuseur)}" placeholder="Canal+"></div>
      </div>
      <div class="champ" style="max-width:220px"><label for="m${i}-sport">Sport</label>
        <div class="select-enveloppe"><select id="m${i}-sport" data-cle="sport">
          ${[['rugby', 'Rugby'], ['football', 'Football'], ['autre', 'Autre']].map(([v, l]) => `<option value="${v}" ${m.sport === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div></div>
    </div>`).join('');
  $('btn-ajouter').disabled = story.matchs.length >= MAX_MATCHS;
}

function changer() {
  sauverBrouillon();
  redessiner();
}

// Champs généraux
for (const [id, cle] of Object.entries(CHAMPS)) {
  $(id).addEventListener('input', e => { story[cle] = e.target.value; majCompteurs(); changer(); });
}
document.querySelectorAll('[data-format]').forEach(b => b.addEventListener('click', () => {
  story.format = b.dataset.format;
  rendreFormat();
  changer();
}));

// Champs des matchs (délégation : la liste est reconstruite à chaque ajout/retrait)
$('matchs').addEventListener('input', e => {
  const bloc = e.target.closest('.match');
  const cle = e.target.dataset.cle;
  if (!bloc || !cle) return;
  const m = story.matchs[+bloc.dataset.i];
  m[cle] = e.target.value;
  if (cle === 'couleurDomicile' || cle === 'couleurExterieur') m[cle] = e.target.value.toUpperCase();
  if (cle === 'date' || cle === 'heure') e.target.classList.toggle('manque', !e.target.value);
  changer();
});
$('matchs').addEventListener('change', async e => {
  const bloc = e.target.closest('.match');
  if (!bloc) return;
  const i = +bloc.dataset.i, m = story.matchs[i];
  const cle = e.target.dataset.cle;
  if (cle === 'sport') changer();
  if (cle === 'domicile' || cle === 'exterieur') equipeRenommee(i, cle);

  // Logo ajouté à la main : réduit, gardé sur ce match et mémorisé pour cette équipe
  const cote = e.target.dataset.logo;
  const fichier = e.target.files?.[0];
  if (cote && fichier) {
    const img = await chargerImage(fichier);
    if (!img) return alert('Image illisible, essayez un autre fichier (PNG ou JPG).');
    const e2 = Math.min(1, 320 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * e2));
    c.height = Math.max(1, Math.round(img.height * e2));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/png');
    m[`logo${SUFFIXE[cote]}`] = dataUrl;
    retenirLogo(m[cote], dataUrl);
    majLogo(i, cote);
    changer();
  }
});

// Équipe renommée à la main : l'ancien logo ne correspond plus, on cherche le nouveau.
function equipeRenommee(i, cote) {
  const m = story.matchs[i];
  m[`wiki${SUFFIXE[cote]}`] = '';
  m[`logo${SUFFIXE[cote]}`] = '';
  majLogo(i, cote);
  changer();
  if (m[cote].trim().length >= 2 && !bibliotheque[normaliser(m[cote])]) chercherLogos([[i, cote]]);
}

async function chercherLogos(liste) {
  const demandes = liste.map(([i, cote]) => ({ i, cote, nom: story.matchs[i][cote].trim(), sport: story.matchs[i].sport }));
  try {
    const r = await fetch('/api/stories/logos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipes: demandes.map(d => ({ nom: d.nom, sport: d.sport })) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    demandes.forEach((q, k) => {
      const m = story.matchs[q.i];
      if (!m || m[q.cote].trim() !== q.nom || !d.titres?.[k]) return;   // renommée entre-temps
      m[`wiki${SUFFIXE[q.cote]}`] = d.titres[k];
      majLogo(q.i, q.cote);
    });
    changer();
  } catch (err) {
    console.warn('Recherche des logos :', err.message);
  }
}

// Vignette d'un logo introuvable (page Wikipédia sans image) : icône d'ajout
$('matchs').addEventListener('error', e => {
  if (e.target.tagName !== 'IMG') return;
  const c = e.target.closest('.logo-case');
  if (!c) return;
  e.target.closest('.logo-btn').classList.add('introuvable');
  e.target.closest('.logo-btn').title = 'Logo introuvable : touchez pour en ajouter un';
  e.target.outerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-photo"/></svg>';
}, true);

$('f-logos').addEventListener('change', e => {
  story.logos = e.target.checked;
  rendreMatchs();
  changer();
});

$('matchs').addEventListener('click', e => {
  const bouton = e.target.closest('button[data-action]');
  if (!bouton) return;
  const i = +bouton.closest('.match').dataset.i;
  if (bouton.dataset.action === 'sans-logo') {
    story.matchs[i][`logo${SUFFIXE[bouton.dataset.cote]}`] = 'aucun';
    majLogo(i, bouton.dataset.cote);
    changer();
    return;
  }
  if (bouton.dataset.action === 'suppr' && story.matchs.length > 1) story.matchs.splice(i, 1);
  if (bouton.dataset.action === 'monter' && i > 0) [story.matchs[i - 1], story.matchs[i]] = [story.matchs[i], story.matchs[i - 1]];
  if (story.matchs.length === 1) story.format = 'affiche';
  rendreMatchs();
  rendreFormat();
  changer();
});
$('btn-ajouter').addEventListener('click', () => {
  if (story.matchs.length >= MAX_MATCHS) return;
  const dernier = story.matchs[story.matchs.length - 1];
  story.matchs.push({ ...matchVide(), sport: dernier?.sport ?? 'rugby' });
  story.format = 'programme';
  rendreMatchs();
  rendreFormat();
  changer();
  $(`m${story.matchs.length - 1}-dom`).focus();
});

async function chargerImage(fichier) {
  try {
    return await createImageBitmap(fichier);
  } catch {
    return new Promise(ok => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = URL.createObjectURL(fichier);
    });
  }
}

// Photo de fond : gardée en mémoire uniquement (trop lourde pour le brouillon)
$('f-photo').addEventListener('change', async e => {
  const fichier = e.target.files?.[0];
  if (!fichier) return;
  photo = await chargerImage(fichier);
  $('photo-nom').textContent = photo ? fichier.name : 'Image illisible, essayez un autre fichier';
  $('btn-sans-photo').hidden = !photo;
  redessiner();
});
$('btn-sans-photo').addEventListener('click', () => {
  photo = null;
  $('f-photo').value = '';
  $('photo-nom').textContent = 'Aucune — fond sombre aux couleurs du Gué';
  $('btn-sans-photo').hidden = true;
  redessiner();
});

$('btn-copier').addEventListener('click', async () => {
  const b = $('btn-copier');
  try {
    await navigator.clipboard.writeText($('f-legende').value);
    b.lastChild.textContent = 'Copié';
  } catch {
    $('f-legende').select();
    b.lastChild.textContent = 'Sélectionné';
  }
  setTimeout(() => { b.lastChild.textContent = 'Copier'; }, 1800);
});

$('btn-vider').addEventListener('click', () => {
  if (!confirm('Effacer la story en cours et repartir de zéro ?')) return;
  story = storyVide();
  $('remarques').hidden = true;
  $('sources').hidden = true;
  rendreChamps();
  changer();
});

// ---------------------------------------------------------------------------
//  Export
// ---------------------------------------------------------------------------
function nomFichier() {
  const d = story.matchs.find(m => m.date)?.date || new Date().toISOString().slice(0, 10);
  return `story-gue-des-moines-${d}.png`;
}
async function enImage() {
  await polices;
  dessiner();
  return new Promise(ok => canvas.toBlob(ok, 'image/png'));
}
function avertirSiIncomplet() {
  const manques = story.matchs.slice(0, story.format === 'affiche' ? 1 : MAX_MATCHS)
    .filter(m => !m.date || !m.heure || !m.domicile || !m.exterieur).length;
  return !manques || confirm(`${manques} match${manques > 1 ? 's ont' : ' a'} une équipe, une date ou une heure manquante. Exporter quand même ?`);
}

$('btn-telecharger').addEventListener('click', async () => {
  if (!avertirSiIncomplet()) return;
  const blob = await enImage();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nomFichier();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$('btn-partager').addEventListener('click', async () => {
  if (!avertirSiIncomplet()) return;
  const blob = await enImage();
  const fichier = new File([blob], nomFichier(), { type: 'image/png' });
  if (navigator.canShare?.({ files: [fichier] })) {
    // La légende part dans le presse-papiers : Instagram n'accepte pas de
    // texte joint à une story partagée.
    if (story.legende) navigator.clipboard?.writeText(story.legende).catch(() => {});
    try {
      await navigator.share({ files: [fichier], title: 'Story Le Gué des Moines' });
    } catch (err) {
      if (err.name !== 'AbortError') alert('Partage impossible : ' + err.message);
    }
  } else {
    // Ordinateur : pas de feuille de partage, on télécharge.
    $('btn-telecharger').click();
  }
});

// ---------------------------------------------------------------------------
//  Agent
// ---------------------------------------------------------------------------
const ETAPES = [
  'L\'agent lit votre demande…',
  'Recherche des matchs et des horaires officiels…',
  'Vérification des chaînes de diffusion…',
  'Rédaction de l\'accroche et de la légende…',
  'Mise en forme de la story…',
];

function statut(html, ko = false) {
  const el = $('statut');
  el.hidden = !html;
  el.classList.toggle('ko', ko);
  el.innerHTML = html;
}

function afficherRemarques(s) {
  const r = $('remarques');
  r.hidden = !s.remarques;
  r.innerHTML = s.remarques ? `<strong>À vérifier avant de publier :</strong> ${echap(s.remarques)}` : '';
  const src = $('sources');
  src.hidden = !s.sources?.length;
  src.innerHTML = s.sources?.length
    ? 'Sources : ' + s.sources.map(x => `<a href="${echap(x.url)}" target="_blank" rel="noopener noreferrer">${echap(x.titre)}</a>`).join('')
    : '';
}

async function preparer() {
  const demande = $('demande').value.trim();
  if (demande.length < 3) {
    statut('Décrivez d\'abord les matchs à annoncer.', true);
    $('demande').focus();
    return;
  }
  const bouton = $('btn-preparer');
  const libelle = bouton.innerHTML;
  bouton.disabled = true;
  bouton.innerHTML = '<span class="loader" aria-hidden="true"></span>L\'agent travaille…';
  const debut = Date.now();
  const rechercheWeb = $('recherche').checked;
  const minuteur = setInterval(() => {
    const s = Math.round((Date.now() - debut) / 1000);
    const etape = ETAPES[Math.min(ETAPES.length - 1, Math.floor(s / (rechercheWeb ? 12 : 5)))];
    statut(`<span class="loader" aria-hidden="true"></span>${etape} <span class="case">${s} s</span>`);
  }, 1000);
  statut(`<span class="loader" aria-hidden="true"></span>${ETAPES[0]}`);

  try {
    const r = await fetch('/api/stories/preparer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demande, rechercheWeb }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? `Erreur ${r.status}`);
    const photoAvant = photo;
    story = { ...storyVide(), ...d.story };
    photo = photoAvant;
    rendreChamps();
    afficherRemarques(d.story);
    changer();
    statut(`Story prête en ${Math.round((Date.now() - debut) / 1000)} s. Relisez, ajustez si besoin, puis partagez.`);
    if (window.estMobile?.()) document.querySelector('.apercu').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    statut(echap(err.message), true);
  } finally {
    clearInterval(minuteur);
    bouton.disabled = false;
    bouton.innerHTML = libelle;
  }
}

$('btn-preparer').addEventListener('click', preparer);
$('demande').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) preparer();
});
$('exemples').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  $('demande').value = b.textContent.trim();
  $('demande').focus();
});

// ---------------------------------------------------------------------------
//  Démarrage : les polices doivent être chargées avant de dessiner, sinon le
//  canevas retombe sur une police système et l'export ne ressemble pas à l'aperçu.
// ---------------------------------------------------------------------------
const polices = Promise.all([
  document.fonts.load('100px "Anton"'),
  ...['500', '600', '700', '800'].map(g => document.fonts.load(`${g} 40px "Inter"`)),
]).catch(() => {});

lireBrouillon();
rendreChamps();
dessiner();
polices.then(redessiner);
logo.onload = redessiner;
