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
  format: 'affiche', badge: 'DIFFUSION EN DIRECT', titre: '', sousTitre: '',
  matchs: [matchVide()], offre: '', legende: '', logos: true,
  taille: 'story',                         // 'story' (9:16) ou 'post' (3:4, fil Instagram)

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
// Parti pris graphique : fond noir plat ; deux familles condensées de la même
// veine (Anton pour les titres, les noms et l'heure ; Oswald pour tout le
// reste) ; une seule couleur d'accent, l'ambre de la marque, réservée au
// surtitre, à l'heure du coup d'envoi et à l'offre. Pas d'ombre, de halo, de
// dégradé ni de cadre : les blocs se séparent par l'espace et, dans le
// programme, par de simples filets. Tous les textes sont posés sur leur ligne
// de base (hauteur des capitales), ce qui rend les espacements réguliers.
// Deux formats d'image. La zone lisible d'une story évite le haut (barre de
// progression, profil) et le bas (champ de réponse) qu'Instagram recouvre ;
// un post du fil n'a rien par-dessus : simples marges.
const L = 1080;
const TAILLES = {
  story: { h: 1920, haut: 260, bas: 1650, libelle: 'Story' },
  post: { h: 1440, haut: 110, bas: 1330, libelle: 'Post' },
};
let H = 1920, HAUT = 260, BAS = 1650;
const C = {
  fond: '#000000',
  ambre: '#F5A425',
  blanc: '#FFFFFF',
  gris: '#A8A39A',
  filet: '#2E2A26',
  medaillon: '#1C1A17',
  surAmbre: '#1A1206',
};
const DISPLAY = '"Anton", Impact, "Arial Narrow", sans-serif';
const TEXTE = '"Oswald", "Arial Narrow", sans-serif';
const MARGE = 90;
const LARGEUR = L - 2 * MARGE;
const SIGNATURE = 'LE GUÉ DES MOINES · BRUGUIÈRES';

const canvas = $('story');
const ctx = canvas.getContext('2d');

function police(taille, famille = DISPLAY, graisse = '400') {
  ctx.font = `${graisse} ${Math.round(taille)}px ${famille}`;
}
function espacement(px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}
const largeurTexte = t => ctx.measureText(t).width;
// Hauteur des capitales en proportion du corps, mesurée à chaque dessin (les
// polices web peuvent arriver après le premier rendu).
const RATIO = { [DISPLAY]: 0.73, [TEXTE]: 0.7 };
function mesurerRatios() {
  for (const f of [DISPLAY, TEXTE]) {
    police(100, f);
    const a = ctx.measureText('H').actualBoundingBoxAscent;
    if (a > 0) RATIO[f] = a / 100;
  }
}
const ratioCapitale = famille => RATIO[famille];

/** Taille la plus grande (≤ max) pour que le texte tienne en largeur. */
function ajuster(txt, max, largeur, famille = DISPLAY, graisse = '400') {
  police(max, famille, graisse);
  const w = largeurTexte(txt);
  const t = w > largeur ? Math.max(16, Math.floor(max * largeur / w)) : max;
  police(t, famille, graisse);
  return t;
}

/**
 * Écrit une ligne dont le haut des capitales tombe en y.
 * Renvoie la taille réellement utilisée (réduite si le texte dépasse `largeur`).
 */
function ecrire(txt, x, y, { taille, famille = TEXTE, graisse = '400', couleur = C.blanc, align = 'left', suivi = 0, largeur = LARGEUR }) {
  espacement(suivi);
  const t = ajuster(txt, taille, largeur, famille, graisse);
  ctx.fillStyle = couleur;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, x, y + t * ratioCapitale(famille));
  espacement(0);
  return t;
}

/** Coupe un titre en 1 à 3 lignes équilibrées, à la plus grande taille possible. */
function couperTitre(titre, largeur, max) {
  const mots = titre.split(/\s+/).filter(Boolean);
  if (!mots.length) return { lignes: [], taille: max };
  police(max);
  const tailleDe = lignes => Math.min(max, Math.floor(max * largeur / Math.max(...lignes.map(largeurTexte))));
  const candidats = [[mots.join(' ')]];
  for (let i = 1; i < mots.length; i++) candidats.push([mots.slice(0, i).join(' '), mots.slice(i).join(' ')]);
  for (let i = 1; i < mots.length; i++) {
    for (let j = i + 1; j < mots.length; j++) {
      candidats.push([mots.slice(0, i).join(' '), mots.slice(i, j).join(' '), mots.slice(j).join(' ')]);
    }
  }
  const seuils = { 1: max * 0.78, 2: max * 0.62, 3: 0 };
  for (const n of [1, 2, 3]) {
    const options = candidats.filter(c => c.length === n);
    if (!options.length) continue;
    const meilleur = options.reduce((a, b) => (tailleDe(b) > tailleDe(a) ? b : a));
    const t = tailleDe(meilleur);
    if (t >= seuils[n] || n === Math.min(3, mots.length)) return { lignes: meilleur, taille: Math.max(t, 56) };
  }
  return { lignes: [mots.join(' ')], taille: tailleDe([mots.join(' ')]) };
}

/** Coupe un texte courant sur plusieurs lignes (police courante). */
function couperTexte(txt, largeur, maxLignes) {
  // Espace insécable avant « ! ? : ; » : la ponctuation ne part jamais seule à la ligne
  const mots = txt.replace(/\s+([!?:;»])/g, ' $1').replace(/(«)\s+/g, '$1 ').split(/ +/).filter(Boolean);
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
const infosMatch = m => [m.competition, m.diffuseur].filter(Boolean).join(' — ').toUpperCase();

function dessinerFond() {
  ctx.fillStyle = C.fond;
  ctx.fillRect(0, 0, L, H);
  if (!photo) return;
  // Photo recadrée en « cover » sous un voile noir uniforme : le texte reste lisible.
  const pw = photo.width, ph = photo.height;
  const e = Math.max(L / pw, H / ph);
  ctx.drawImage(photo, (L - pw * e) / 2, (H - ph * e) / 2, pw * e, ph * e);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(0, 0, L, H);
}

function initiales(nom) {
  const mots = nom.split(/[\s-]+/).filter(m => m && !/^(de|du|des|d'|l'|et)$/i.test(m));
  if (!mots.length) return '?';
  return (mots.length === 1 ? mots[0].slice(0, 2) : mots[0][0] + mots[1][0]).toUpperCase();
}

/** Logo de l'équipe, sans déformation, dans un carré de côté t centré en (cx, cy).
 *  À défaut de logo : médaillon sobre (anneau à la couleur du club, initiales). */
function dessinerBlason(m, cote, cx, cy, t) {
  const img = imageLogo(m, cote);
  if (img) {
    const e = Math.min(t / img.naturalWidth, t / img.naturalHeight);
    const w = img.naturalWidth * e, h = img.naturalHeight * e;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    return;
  }
  const r = t * 0.44;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = C.medaillon;
  ctx.fill();
  ctx.lineWidth = Math.max(3, t * 0.025);
  ctx.strokeStyle = m[`couleur${SUFFIXE[cote]}`] || '#5C5650';
  ctx.stroke();
  const txt = initiales(nomEquipe(m[cote], cote === 'domicile' ? 'Équipe 1' : 'Équipe 2'));
  const taille = ajuster(txt, r * 0.9, r * 1.3);
  ctx.fillStyle = C.blanc;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, cx, cy + taille * ratioCapitale(DISPLAY) / 2);
}

// --- Blocs communs aux deux mises en page ------------------------------------
// Chaque bloc connaît sa hauteur avant d'être dessiné : la page est composée
// d'abord (choix des tailles, répartition des espaces), dessinée ensuite.

function blocSurtitre(align) {
  const txt = (story.badge || '').trim().toUpperCase();
  if (!txt) return null;
  const taille = 32;
  return {
    h: taille * ratioCapitale(TEXTE),
    dessiner: y => ecrire(txt, align === 'center' ? L / 2 : MARGE, y,
      { taille, graisse: '500', couleur: C.ambre, align, suivi: 4 }),
  };
}

function blocTitre(align, max) {
  const titre = (story.titre || '').trim().toUpperCase();
  if (!titre) return null;
  const { lignes, taille } = couperTitre(titre, LARGEUR, max);
  const pas = taille * 1.02;
  return {
    h: (lignes.length - 1) * pas + taille * ratioCapitale(DISPLAY),
    dessiner: y => lignes.forEach((l, i) => ecrire(l, align === 'center' ? L / 2 : MARGE, y + i * pas,
      { taille, famille: DISPLAY, align })),
  };
}

function blocSousTitre(align) {
  const txt = (story.sousTitre || '').trim();
  if (!txt) return null;
  const taille = 38, pas = 52;
  police(taille, TEXTE, '400');
  const lignes = couperTexte(txt, align === 'center' ? 860 : LARGEUR, 2);
  return {
    h: (lignes.length - 1) * pas + taille * ratioCapitale(TEXTE),
    dessiner: y => lignes.forEach((l, i) => ecrire(l, align === 'center' ? L / 2 : MARGE, y + i * pas,
      { taille, couleur: C.gris, align })),
  };
}

/** Offre réelle (prix, bière…) : pastille ambre pleine, à plat, comme les boutons de la marque. */
function blocOffre(align) {
  const txt = (story.offre || '').trim().toUpperCase();
  if (!txt) return null;
  const h = 80, taille = 32;
  espacement(1.5);
  const t = ajuster(txt, taille, LARGEUR - 96, TEXTE, '500');
  const w = Math.min(LARGEUR, largeurTexte(txt) + 96);
  espacement(0);
  return {
    h,
    dessiner: y => {
      const x = align === 'center' ? (L - w) / 2 : MARGE;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fillStyle = C.ambre;
      ctx.fill();
      ecrire(txt, x + w / 2, y + (h - t * ratioCapitale(TEXTE)) / 2,
        { taille: t, graisse: '500', couleur: C.surAmbre, align: 'center', suivi: 1.5 });
    },
  };
}

/** Signature : le logo de la maison et son nom en clair (le texte du logo est illisible en petit). */
function blocSignature(align, hLogo) {
  const taille = 22;
  const cap = taille * ratioCapitale(TEXTE);
  const ok = logo.complete && logo.naturalWidth;
  const wLogo = ok ? hLogo * logo.naturalWidth / logo.naturalHeight : hLogo;
  if (align === 'center') {
    return {
      h: hLogo + 22 + cap,
      dessiner: y => {
        if (ok) ctx.drawImage(logo, (L - wLogo) / 2, y, wLogo, hLogo);
        ecrire(SIGNATURE, L / 2, y + hLogo + 22, { taille, couleur: C.gris, align: 'center', suivi: 3 });
      },
    };
  }
  return {
    h: hLogo,
    dessiner: y => {
      if (ok) ctx.drawImage(logo, MARGE, y, wLogo, hLogo);
      ecrire(SIGNATURE, MARGE + wLogo + 28, y + (hLogo - cap) / 2, { taille, couleur: C.gris, suivi: 3 });
    },
  };
}

/**
 * Compose la page en trois groupes : l'en-tête est calé en haut de la zone
 * lisible, la signature en bas, et le corps (le match, la liste) est centré
 * optiquement entre les deux. À l'intérieur d'un groupe, les écarts sont fixes.
 * `tient` est faux s'il reste moins de `minAir` au-dessus ou au-dessous du corps.
 */
function composer({ tete = [], corps = [], pied = [] }, minAir = 64) {
  const t = tete.filter(Boolean), c = corps.filter(Boolean), p = pied.filter(Boolean);
  const hauteur = blocs => blocs.reduce((s, x, i) => s + x.h + (i < blocs.length - 1 ? x.ecart : 0), 0);
  const ht = hauteur(t), hc = hauteur(c), hp = hauteur(p);
  const air = BAS - HAUT - ht - hc - hp;
  const poser = (blocs, y) => blocs.forEach(x => { x.dessiner(y); y += x.h + x.ecart; });
  return {
    air,
    tient: air >= minAir * ((t.length ? 1 : 0) + (p.length ? 1 : 0)),
    dessiner() {
      poser(t, HAUT);
      poser(p, BAS - hp);
      poser(c, HAUT + ht + Math.max(0, air) * (t.length ? 0.46 : 0.42));   // centre optique, un peu au-dessus du milieu
    },
  };
}
const avec = (bloc, ecart = 0) => (bloc ? Object.assign(bloc, { ecart }) : null);

// --- Mise en page « Affiche » : un seul match, en grand ----------------------
function blocMatchAffiche(m, k) {
  const capD = ratioCapitale(DISPLAY);
  const a = nomEquipe(m.domicile, 'Équipe 1'), b = nomEquipe(m.exterieur, 'Équipe 2');
  // Avec au moins un logo : les deux blasons face à face. Sinon, les noms seuls, en grand.
  if (aUnLogo(m, 'domicile') || aUnLogo(m, 'exterieur')) {
    const t = 290 * k, dx = 230;
    const na = couperNom(a, 400, 56 * k), nb = couperNom(b, 400, 56 * k);
    const taille = Math.min(na.taille, nb.taille);        // même corps pour les deux noms
    const pas = taille * 1.04;
    const nLignes = Math.max(na.lignes.length, nb.lignes.length);
    const hNoms = (nLignes - 1) * pas + taille * capD;
    return {
      h: t + 36 * k + hNoms,
      dessiner: y => {
        dessinerBlason(m, 'domicile', L / 2 - dx, y + t / 2, t);
        dessinerBlason(m, 'exterieur', L / 2 + dx, y + t / 2, t);
        const tVs = 34;
        ecrire('VS', L / 2, y + t / 2 - tVs * ratioCapitale(TEXTE) / 2, { taille: tVs, graisse: '500', couleur: C.gris, align: 'center', suivi: 3 });
        for (const [n, cx] of [[na, L / 2 - dx], [nb, L / 2 + dx]]) {
          n.lignes.forEach((l, i) => ecrire(l, cx, y + t + 36 * k + i * pas, { taille, famille: DISPLAY, align: 'center', largeur: 420 }));
        }
      },
    };
  }
  police(118 * k);
  const taille = Math.min(118 * k, Math.floor(118 * k * LARGEUR / Math.max(largeurTexte(a), largeurTexte(b))));
  const cap = taille * capD, tVs = 34, capVs = tVs * ratioCapitale(TEXTE), g = 34 * k;
  return {
    h: cap + g + capVs + g + cap,
    dessiner: y => {
      ecrire(a, L / 2, y, { taille, famille: DISPLAY, align: 'center' });
      ecrire('VS', L / 2, y + cap + g, { taille: tVs, graisse: '500', couleur: C.gris, align: 'center', suivi: 3 });
      ecrire(b, L / 2, y + cap + g + capVs + g, { taille, famille: DISPLAY, align: 'center' });
    },
  };
}

/** Date en toutes lettres, heure en grand (l'information n° 1), compétition et chaîne. */
function blocHoraire(m, k) {
  const tDate = 42 * k, tInfos = 30 * k;
  const date = jourMatch(m.date, true) || 'DATE À CONFIRMER';
  const heure = heureMatch(m.heure) || 'HORAIRE À CONFIRMER';
  // Corps réel de l'heure (une mention « à confirmer » est réduite pour tenir) :
  // les espaces se calculent sur ce qui est vraiment dessiné.
  const tHeure = ajuster(heure, (heureMatch(m.heure) ? 190 : 96) * k, LARGEUR);
  const infos = infosMatch(m);
  const capT = ratioCapitale(TEXTE), capD = ratioCapitale(DISPLAY);
  const g1 = 30 * k, g2 = 34 * k;
  return {
    h: tDate * capT + g1 + tHeure * capD + (infos ? g2 + tInfos * capT : 0),
    dessiner: y => {
      ecrire(date, L / 2, y, { taille: tDate, graisse: '500', align: 'center', suivi: 3 });
      let yy = y + tDate * capT + g1;
      ecrire(heure, L / 2, yy, { taille: tHeure, famille: DISPLAY, couleur: C.ambre, align: 'center' });
      yy += tHeure * capD + g2;
      if (infos) ecrire(infos, L / 2, yy, { taille: tInfos, couleur: C.gris, align: 'center', suivi: 2 });
    },
  };
}

function dessinerAffiche() {
  const m = story.matchs[0] ?? matchVide();
  let page;
  // Le corps prend la plus grande échelle qui laisse de l'air au-dessus et au-dessous.
  for (const k of [1.12, 1.04, 1, 0.92, 0.84, 0.76, 0.68, 0.62]) {
    page = composer({
      tete: [
        avec(blocSurtitre('center'), story.titre ? 30 : 26),
        avec(blocTitre('center', Math.min(1, k) * 128), 26),
        avec(blocSousTitre('center')),
      ],
      corps: [avec(blocMatchAffiche(m, k), 96 * k), avec(blocHoraire(m, k))],
      pied: [avec(blocOffre('center'), 52), avec(blocSignature('center', 88))],
    });
    if (page.tient) break;
  }
  page.dessiner();
}

// --- Mise en page « Programme » : 2 à 6 matchs -------------------------------
// Une grille de programme TV : colonne date/heure, colonne affiche, filets fins.
function blocListe(matchs, hLigne) {
  const capT = ratioCapitale(TEXTE), capD = ratioCapitale(DISPLAY);
  const wHeure = Math.max(210, Math.min(270, hLigne * 0.9));   // colonne date / heure
  const xD = MARGE + wHeure + 26;                               // début de la colonne des équipes
  const wD = L - MARGE - xD;
  const filet = y => {
    ctx.fillStyle = C.filet;
    ctx.fillRect(MARGE, y - 1, LARGEUR, 2);
  };
  return {
    h: matchs.length * hLigne,
    dessiner: y0 => {
      filet(y0);
      matchs.forEach((m, i) => {
        const y = y0 + i * hLigne;
        filet(y + hLigne);

        // Colonne date / heure
        const tJour = Math.max(22, Math.min(32, hLigne * 0.11));
        const tHeure = Math.max(52, Math.min(112, hLigne * 0.38));
        const gJ = Math.max(12, hLigne * 0.07);
        const hBloc = tJour * capT + gJ + tHeure * capD;
        const yb = y + (hLigne - hBloc) / 2;
        ecrire(jourMatch(m.date) || 'DATE À CONFIRMER', MARGE, yb, { taille: tJour, graisse: '500', couleur: C.gris, suivi: 2, largeur: wHeure });
        ecrire(heureMatch(m.heure) || 'À CONFIRMER', MARGE, yb + tJour * capT + gJ, { taille: tHeure, famille: DISPLAY, couleur: C.ambre, largeur: wHeure });

        // Colonne des équipes
        const infos = infosMatch(m);
        const tInfos = Math.max(20, Math.min(30, hLigne * 0.105));
        const logos = aUnLogo(m, 'domicile') || aUnLogo(m, 'exterieur');
        const a = nomEquipe(m.domicile, 'Équipe 1'), b = nomEquipe(m.exterieur, 'Équipe 2');
        if (hLigne >= 196) {
          // Une équipe par ligne, logo en tête de ligne
          const tNom = Math.min(76, hLigne * 0.24);
          const tLogo = logos ? tNom * 1.3 : 0;
          const hEq = Math.max(tLogo, tNom * capD);         // hauteur d'une ligne d'équipe
          const gEq = logos ? 12 : tNom * 0.4;              // entre les deux équipes
          const gI = Math.max(16, hLigne * 0.08);
          const hTout = 2 * hEq + gEq + (infos ? gI + tInfos * capT : 0);
          let yy = y + (hLigne - hTout) / 2;
          const decal = logos ? tLogo + 24 : 0;
          police(tNom);
          const nomTaille = Math.min(tNom, ...[a, b].map(nm => Math.floor(tNom * (wD - decal) / Math.max(largeurTexte(nm), 1))));
          for (const [cote, nom] of [['domicile', a], ['exterieur', b]]) {
            if (logos) dessinerBlason(m, cote, xD + tLogo / 2, yy + hEq / 2, tLogo);
            ecrire(nom, xD + decal, yy + (hEq - nomTaille * capD) / 2, { taille: nomTaille, famille: DISPLAY, largeur: wD - decal });
            yy += hEq + gEq;
          }
          yy += gI - gEq;
          if (infos) ecrire(infos, xD, yy, { taille: tInfos, couleur: C.gris, suivi: 2, largeur: wD });
        } else {
          // Affiche sur une ligne, logos alignés au bout
          let wTexte = wD;
          if (logos) {
            const t = Math.min(hLigne * 0.5, 72);
            const cxB = L - MARGE - t / 2, cxA = cxB - t - 16;
            dessinerBlason(m, 'domicile', cxA, y + hLigne / 2, t);
            dessinerBlason(m, 'exterieur', cxB, y + hLigne / 2, t);
            wTexte = wD - 2 * t - 48;
          }
          const tNom = Math.min(50, hLigne * 0.34);
          const gI = Math.max(12, hLigne * 0.09);
          espacement(0);
          const tN = ajuster(`${a} – ${b}`, tNom, wTexte);
          const hTout = tN * capD + (infos ? gI + tInfos * capT : 0);
          const yy = y + (hLigne - hTout) / 2;
          ecrire(`${a} – ${b}`, xD, yy, { taille: tN, famille: DISPLAY, largeur: wTexte });
          if (infos) ecrire(infos, xD, yy + tN * capD + gI, { taille: tInfos, couleur: C.gris, suivi: 2, largeur: wTexte });
        }
      });
    },
  };
}

function dessinerProgramme() {
  const matchs = story.matchs.slice(0, MAX_MATCHS);
  const n = Math.max(1, matchs.length);
  const plafond = n <= 2 ? 300 : n === 3 ? 260 : 230;   // peu de matchs : des lignes plus généreuses
  let page;
  for (const k of [1, 0.9, 0.8, 0.7]) {
    const tete = [
      avec(blocSurtitre('left'), story.titre ? 28 : 24),
      avec(blocTitre('left', 120 * k), 24),
      avec(blocSousTitre('left')),
    ];
    const pied = [avec(blocOffre('left'), 48), avec(blocSignature('left', 80))];
    const sansListe = composer({ tete, pied });
    const hLigne = Math.min(plafond, Math.floor((sansListe.air - 2 * 64) / n));
    page = composer({ tete, corps: [avec(blocListe(matchs, Math.max(hLigne, 100)))], pied });
    if (hLigne >= 116) break;
  }
  page.dessiner();
}

function appliquerTaille() {
  const t = TAILLES[story.taille] ?? TAILLES.story;
  if (canvas.height !== t.h) canvas.height = t.h;
  ({ h: H, haut: HAUT, bas: BAS } = t);
  canvas.style.aspectRatio = `${L} / ${H}`;
}

function dessiner() {
  appliquerTaille();
  ctx.save();
  ctx.clearRect(0, 0, L, H);
  mesurerRatios();
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

function rendreTaille() {
  const post = story.taille === 'post';
  document.querySelectorAll('[data-taille]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.taille === (post ? 'post' : 'story'))));
  $('apercu-aide').textContent = post
    ? 'Image 1080 × 1440 px (3:4), le format des posts du fil Instagram.'
    : "Image 1080 × 1920 px (9:16). Le haut et le bas restent libres pour les barres d'Instagram.";
}

function rendreFormat() {
  rendreTaille();
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
document.querySelectorAll('[data-taille]').forEach(b => b.addEventListener('click', () => {
  story.taille = b.dataset.taille;
  rendreTaille();
  changer();
}));
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
  return `${story.taille === 'post' ? 'post' : 'story'}-gue-des-moines-${d}.png`;
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
      await navigator.share({ files: [fichier], title: `${(TAILLES[story.taille] ?? TAILLES.story).libelle} Le Gué des Moines` });
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
  ...['400', '500'].map(g => document.fonts.load(`${g} 40px "Oswald"`)),
]).catch(() => {});

lireBrouillon();
rendreChamps();
dessiner();
polices.then(redessiner);
logo.onload = redessiner;
