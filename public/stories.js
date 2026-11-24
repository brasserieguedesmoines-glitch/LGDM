// Stories Instagram (1080 × 1920) pour les marchés de Noël et autres événements.
// Tout est dessiné sur un canvas : l'image téléchargée est exactement l'aperçu,
// sans dépendance à une librairie de capture d'écran.
//
// Zones de sécurité Instagram : le haut (barre de progression, nom du compte)
// et le bas (champ de réponse) sont recouverts par l'interface. Le contenu utile
// reste donc entre ZONE.haut et ZONE.bas ; seuls les décors débordent.

const W = 1080, H = 1920;
const ZONE = { logo: 256, haut: 476, bas: 1640 };

const C = {
  fond: '#0D0D0D', carte: '#1A1714', carte2: '#201C18',
  ambre: '#F5A425', orange: '#F0921E', brun: '#5C3A17',
  blanc: '#FFFFFF', gris: '#A8A39A', creme: '#FFE7BD',
  filet: 'rgba(255,255,255,0.09)',
};
const DISPLAY = '"Anton", Impact, "Arial Narrow", sans-serif';
const TEXTE = '"Inter", system-ui, -apple-system, sans-serif';

// ---------------------------------------------------------------- dates
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
  'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_COURT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août',
  'sept.', 'oct.', 'nov.', 'déc.'];

function laDate(iso) {
  const [a, m, j] = String(iso || '').split('-').map(Number);
  return a && m && j ? new Date(a, m - 1, j) : null;
}
const majuscule = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const dateLongue = d => `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;

// « du 27 au 29 novembre », « le 27 novembre », « du 30 nov. au 2 déc. »
function plageDates(jours) {
  const ds = jours.map(j => laDate(j.date)).filter(Boolean).sort((a, b) => a - b);
  if (!ds.length) return '';
  const a = ds[0], b = ds[ds.length - 1];
  if (ds.length === 1 || +a === +b) return `le ${a.getDate()} ${MOIS[a.getMonth()]}`;
  if (a.getMonth() === b.getMonth()) return `du ${a.getDate()} au ${b.getDate()} ${MOIS[b.getMonth()]}`;
  return `du ${a.getDate()} ${MOIS_COURT[a.getMonth()]} au ${b.getDate()} ${MOIS_COURT[b.getMonth()]}`;
}
const plageCourte = jours => plageDates(jours)
  .replace(/^du (\d+) au (\d+) (\S+)$/, (_, a, b, m) => `${a} – ${b} ${m}`)
  .replace(/^le /, '').replace(/^du (.+) au (.+)$/, '$1 – $2');

// « 18h-21h », « 18 h – 21 h » → « 18h – 21h »
const horaires = s => String(s || '').trim().replace(/\s*h\s*/gi, 'h').replace(/\s*[-–—à]\s*/g, ' – ');
const heureDebut = s => { const m = String(s || '').match(/(\d{1,2})\s*h/i); return m ? +m[1] : null; };

function joursAvant(iso, aujourdhui = new Date()) {
  const d = laDate(iso); if (!d) return 1;
  const t = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate());
  return Math.round((d - t) / 86400000);
}

// -------------------------------------------------------------- outils canvas
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hasard(graine) {           // mulberry32 : décor identique à chaque rendu
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hauteurCap = (ctx, police) => { ctx.font = police; return ctx.measureText('H').actualBoundingBoxAscent; };

// Texte espacé lettre par lettre (letterSpacing n'existe pas partout sur canvas)
function largeurEspacee(ctx, txt, esp) {
  let w = 0; for (const ch of txt) w += ctx.measureText(ch).width + esp;
  return w - esp;
}
function texteEspace(ctx, txt, x, y, esp, align = 'left') {
  const w = largeurEspacee(ctx, txt, esp);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const a = ctx.textAlign; ctx.textAlign = 'left';
  for (const ch of txt) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + esp; }
  ctx.textAlign = a;
  return w;
}

function couper(ctx, txt, largeur) {
  const lignes = [];
  for (const para of String(txt || '').split('\n')) {
    let l = '';
    for (const mot of para.split(/\s+/).filter(Boolean)) {
      const essai = l ? `${l} ${mot}` : mot;
      if (ctx.measureText(essai).width > largeur && l) { lignes.push(l); l = mot; } else l = essai;
    }
    lignes.push(l);
  }
  return lignes;
}

// Plus grande taille (≤ max) pour laquelle chaque ligne tient dans la largeur
function tailleQuiTient(ctx, lignes, max, largeur, famille = DISPLAY, poids = '') {
  let t = max;
  for (const l of lignes) {
    ctx.font = `${poids} ${t}px ${famille}`;
    const w = ctx.measureText(l).width;
    if (w > largeur) t = Math.floor(t * largeur / w);
  }
  return t;
}

// Coupe un intitulé en deux lignes équilibrées (« Marché | de Noël »)
function deuxLignes(txt) {
  const mots = String(txt || '').trim().split(/\s+/).filter(Boolean);
  if (mots.length < 2) return [mots.join(' ')];
  let mieux = null;
  for (let i = 1; i < mots.length; i++) {
    const l = [mots.slice(0, i).join(' '), mots.slice(i).join(' ')];
    const score = Math.max(l[0].length, l[1].length);
    if (!mieux || score < mieux.score) mieux = { score, l };
  }
  return mieux.l;
}

// Icônes au trait (Lucide, MIT), dessinées dans une boîte de 24 × 24
const ICONES = {
  lieu: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', 'M15 10a3 3 0 1 1-6 0a3 3 0 1 1 6 0z'],
  horloge: ['M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0z', 'M12 6v6l4 2'],
  calendrier: ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M16 2v4M8 2v4M3 10h18'],
};
function icone(ctx, nom, x, y, taille, couleur, epaisseur = 2.2) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(taille / 24, taille / 24);
  ctx.strokeStyle = couleur; ctx.lineWidth = epaisseur; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const d of ICONES[nom]) ctx.stroke(new Path2D(d));
  ctx.restore();
}

// Étincelle à quatre branches
function etincelle(ctx, x, y, r, couleur, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = couleur;
  ctx.shadowColor = couleur; ctx.shadowBlur = r * 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + r * 0.12, y - r * 0.12, x + r, y);
  ctx.quadraticCurveTo(x + r * 0.12, y + r * 0.12, x, y + r);
  ctx.quadraticCurveTo(x - r * 0.12, y + r * 0.12, x - r, y);
  ctx.quadraticCurveTo(x - r * 0.12, y - r * 0.12, x, y - r);
  ctx.fill();
  ctx.restore();
}

// Flocon à six branches, au trait
function flocon(ctx, x, y, r, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = Math.max(1.5, r / 9); ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, -r);
    ctx.moveTo(0, -r * 0.55); ctx.lineTo(r * 0.22, -r * 0.78);
    ctx.moveTo(0, -r * 0.55); ctx.lineTo(-r * 0.22, -r * 0.78);
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------- décor
function guirlande(ctx, p0, p1, p2, n, { taille = 1, alpha = 1, decalage = 0 } = {}) {
  const pt = t => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#3A2F25'; ctx.lineWidth = 3 * taille;
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y); ctx.stroke();
  const teintes = [C.ambre, C.creme, C.orange];
  for (let i = 0; i <= n; i++) {
    const t = (i + 0.5) / (n + 1);
    const { x, y } = pt(t);
    const coul = teintes[(i + decalage) % teintes.length];
    // halo
    const g = ctx.createRadialGradient(x, y + 16 * taille, 0, x, y + 16 * taille, 70 * taille);
    g.addColorStop(0, coul + '88'); g.addColorStop(0.35, coul + '22'); g.addColorStop(1, coul + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x - 70 * taille, y - 54 * taille, 140 * taille, 140 * taille);
    // culot
    ctx.fillStyle = '#2B231C';
    rr(ctx, x - 6 * taille, y - 2 * taille, 12 * taille, 11 * taille, 3 * taille); ctx.fill();
    // ampoule
    ctx.fillStyle = coul;
    ctx.shadowColor = coul; ctx.shadowBlur = 24 * taille;
    ctx.beginPath(); ctx.ellipse(x, y + 22 * taille, 10 * taille, 15 * taille, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(x - 3 * taille, y + 17 * taille, 3 * taille, 5 * taille, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function decor(ctx, graine) {
  const rnd = hasard(graine);
  ctx.fillStyle = C.fond; ctx.fillRect(0, 0, W, H);

  // Lumière chaude qui descend de la guirlande
  let g = ctx.createRadialGradient(W / 2, 120, 0, W / 2, 120, 1300);
  g.addColorStop(0, 'rgba(240,146,30,0.22)');
  g.addColorStop(0.4, 'rgba(240,146,30,0.07)');
  g.addColorStop(1, 'rgba(240,146,30,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Sol chaud et bokeh en bas
  g = ctx.createLinearGradient(0, H - 620, 0, H);
  g.addColorStop(0, 'rgba(32,28,24,0)'); g.addColorStop(1, 'rgba(46,34,22,0.95)');
  ctx.fillStyle = g; ctx.fillRect(0, H - 620, W, 620);
  for (let i = 0; i < 14; i++) {
    const x = rnd() * W, y = H - 360 + rnd() * 380, r = 24 + rnd() * 70;
    const b = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.06 + rnd() * 0.12;
    b.addColorStop(0, `rgba(245,164,37,${a})`); b.addColorStop(0.7, `rgba(245,164,37,${a * 0.6})`);
    b.addColorStop(1, 'rgba(245,164,37,0)');
    ctx.fillStyle = b; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Neige : points fins partout, plus discrets au centre (derrière le texte)
  ctx.save();
  for (let i = 0; i < 190; i++) {
    const x = rnd() * W, y = rnd() * H;
    const centre = Math.abs(x - W / 2) < 440 && y > ZONE.haut - 20 && y < ZONE.bas + 220;
    const r = centre ? 1 + rnd() * 1.2 : 1.2 + rnd() ** 2.2 * 5;
    const a = (0.12 + rnd() * 0.5) * (centre ? 0.35 : 1);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = r > 4 ? r * 2 : 0;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // Quelques flocons et étincelles, cantonnés aux marges
  const marge = () => (rnd() < 0.5 ? 40 + rnd() * 90 : W - 40 - rnd() * 90);
  for (let i = 0; i < 5; i++) flocon(ctx, marge(), 520 + rnd() * 1150, 14 + rnd() * 16, 0.16 + rnd() * 0.16);
  for (let i = 0; i < 4; i++) etincelle(ctx, marge(), 560 + rnd() * 1050, 9 + rnd() * 10, C.ambre, 0.55 + rnd() * 0.35);

  // Guirlandes lumineuses en haut (sous la barre d'Instagram : purement décoratives)
  guirlande(ctx, { x: -60, y: 118 }, { x: 600, y: 300 }, { x: 1140, y: 40 }, 11, { taille: 0.72, alpha: 0.55, decalage: 1 });
  guirlande(ctx, { x: -60, y: 36 }, { x: 430, y: 290 }, { x: 1140, y: 120 }, 12);
}

function logo(ctx, img, largeur = 168) {
  if (!img) return;
  const h = largeur * img.naturalHeight / img.naturalWidth;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 30;
  ctx.drawImage(img, W / 2 - largeur / 2, ZONE.logo, largeur, h);
  ctx.restore();
}

// ------------------------------------------------------------ blocs empilés
// Chaque bloc connaît sa hauteur avant d'être dessiné : on centre ensuite
// l'ensemble verticalement dans la zone utile, quel que soit le contenu.
// Si le contenu saisi est trop long (beaucoup de jours, longue accroche…), le
// groupe entier est réduit pour ne jamais passer sous l'interface d'Instagram.
function empiler(ctx, blocs, haut = ZONE.haut, bas = ZONE.bas) {
  blocs = blocs.filter(Boolean);
  const total = blocs.reduce((s, b) => s + b.h, 0);
  const dispo = bas - haut;
  const k = Math.min(1, dispo / total);
  ctx.save();
  if (k < 1) { ctx.translate(W / 2, haut); ctx.scale(k, k); ctx.translate(-W / 2, -haut); }
  let y = haut + Math.max(0, (dispo - total) / 2);
  for (const b of blocs) { b.dessiner?.(y); y += b.h; }
  ctx.restore();
}
const espace = h => ({ h });

function bPilule(ctx, texte, { taille = 28, couleur = C.ambre } = {}) {
  const label = texte.toUpperCase();
  const police = `600 ${taille}px ${TEXTE}`;
  ctx.font = police;
  const esp = taille * 0.17, point = taille * 0.3, ecart = taille * 0.55, px = taille * 0.95, h = taille * 2.15;
  const lw = largeurEspacee(ctx, label, esp);
  const w = lw + point * 2 + ecart + px * 2;
  return {
    h, w,
    dessiner(y, cx = W / 2) {
      const x = cx - w / 2;
      ctx.save();
      rr(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = 'rgba(240,146,30,0.08)'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = C.brun; ctx.stroke();
      ctx.fillStyle = couleur;
      ctx.beginPath(); ctx.arc(x + px + point, y + h / 2, point, 0, Math.PI * 2); ctx.fill();
      ctx.font = police; ctx.textBaseline = 'middle';
      texteEspace(ctx, label, x + px + point * 2 + ecart, y + h / 2 + taille * 0.04, esp);
      ctx.restore();
    },
  };
}

// Lignes de titre en capitales compressées ; `couleurs` et `lueur` par ligne
function bTitre(ctx, lignes, { couleurs = [C.blanc, C.ambre], lueur = [false, true], max = 250, largeur = 940, interligne = 0.2 } = {}) {
  lignes = lignes.filter(Boolean).map(l => l.toUpperCase().replace(/'/g, '’'));
  const t = tailleQuiTient(ctx, lignes, max, largeur);
  const police = `${t}px ${DISPLAY}`;
  const cap = hauteurCap(ctx, police);
  const accent = /[ÀÂÄÉÈÊËÎÏÔÖÙÛÜŸ]/;
  const hauts = [0];   // haut de chaque ligne
  for (let i = 1; i < lignes.length; i++)
    hauts.push(hauts[i - 1] + cap + t * interligne + (accent.test(lignes[i]) ? t * 0.12 : 0));
  return {
    h: hauts[hauts.length - 1] + cap,
    taille: t,
    dessiner(y) {
      ctx.save();
      ctx.font = police; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      lignes.forEach((l, i) => {
        const coul = couleurs[i % couleurs.length];
        ctx.shadowColor = lueur[i] ? 'rgba(245,164,37,0.5)' : 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = lueur[i] ? t * 0.28 : t * 0.12;
        ctx.fillStyle = coul;
        ctx.fillText(l, W / 2, y + hauts[i] + cap);
      });
      ctx.restore();
    },
  };
}

function bTexte(ctx, txt, { taille = 38, poids = 500, couleur = C.gris, largeur = 860, interligne = 1.42 } = {}) {
  if (!String(txt || '').trim()) return null;
  const police = `${poids} ${taille}px ${TEXTE}`;
  ctx.font = police;
  const lignes = couper(ctx, txt, largeur);
  const lh = taille * interligne;
  return {
    h: lignes.length * lh,
    dessiner(y) {
      ctx.save();
      ctx.font = police; ctx.fillStyle = couleur; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      lignes.forEach((l, i) => ctx.fillText(l, W / 2, y + lh * i + lh / 2));
      ctx.restore();
    },
  };
}

// Ligne « icône + texte en capitales » centrée
function bIconeTexte(ctx, nomIcone, txt, { taille = 80, couleur = C.blanc, couleurIcone = C.ambre, largeur = 900 } = {}) {
  if (!String(txt || '').trim()) return null;
  txt = txt.toUpperCase();
  let t = taille;
  const mesurer = () => {
    const police = `${t}px ${DISPLAY}`;
    const cap = hauteurCap(ctx, police);
    const ic = cap * 1.05, gap = t * 0.2;
    return { police, cap, ic, gap, w: ic + gap + ctx.measureText(txt).width };
  };
  let m = mesurer();
  if (m.w > largeur) { t = Math.floor(t * largeur / m.w); m = mesurer(); }
  return {
    h: m.cap,
    dessiner(y) {
      const x = W / 2 - m.w / 2;
      icone(ctx, nomIcone, x, y + m.cap / 2 - m.ic / 2, m.ic, couleurIcone, 2.4);
      ctx.save();
      ctx.font = m.police; ctx.fillStyle = couleur; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 14;
      ctx.fillText(txt, x + m.ic + m.gap, y + m.cap);
      ctx.restore();
    },
  };
}

// Carte d'un jour : grand quantième ambré, jour de la semaine, horaires, mention
function carteJour(ctx, j, x, y, w, h) {
  const d = laDate(j.date);
  if (!d) return;
  ctx.save();
  rr(ctx, x, y, w, h, Math.min(30, h * 0.24));
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, 'rgba(32,28,24,0.94)'); g.addColorStop(1, 'rgba(26,23,20,0.94)');
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = C.filet; ctx.stroke();

  // Colonne date
  const col = h * 1.22;
  const pNum = `${Math.round(h * 0.5)}px ${DISPLAY}`;
  const capNum = hauteurCap(ctx, pNum);
  const tMois = Math.round(h * 0.15);
  const pMois = `600 ${tMois}px ${TEXTE}`;
  const capMois = hauteurCap(ctx, pMois);
  const bloc = capNum + h * 0.09 + capMois;
  const y0 = y + (h - bloc) / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = pNum; ctx.fillStyle = C.ambre;
  ctx.shadowColor = 'rgba(245,164,37,0.45)'; ctx.shadowBlur = 22;
  ctx.fillText(String(d.getDate()), x + col / 2, y0 + capNum);
  ctx.shadowBlur = 0;
  ctx.font = pMois; ctx.fillStyle = C.gris;
  texteEspace(ctx, MOIS_COURT[d.getMonth()].replace('.', '').toUpperCase(), x + col / 2, y0 + bloc, tMois * 0.2, 'center');

  // Filet vertical
  ctx.fillStyle = C.filet;
  ctx.fillRect(x + col, y + h * 0.2, 2, h * 0.6);

  // Mention à droite (pilule)
  let droite = x + w - h * 0.22;
  if (j.mention) {
    const p = bPilule(ctx, j.mention, { taille: Math.round(h * 0.13) });
    p.dessiner(y + h / 2 - p.h / 2, droite - p.w / 2);
    droite -= p.w + 16;
  }

  // Jour de la semaine + horaires
  const xt = x + col + h * 0.24;
  const pJour = `${Math.round(h * 0.37)}px ${DISPLAY}`;
  const capJour = hauteurCap(ctx, pJour);
  const hor = horaires(j.horaires);
  const tHor = Math.round(h * 0.215);
  const pHor = `600 ${tHor}px ${TEXTE}`;
  const capHor = hor ? hauteurCap(ctx, pHor) : 0;
  const ecart = hor ? h * 0.12 : 0;
  const yj = y + (h - (capJour + ecart + capHor)) / 2;
  ctx.textAlign = 'left';
  ctx.font = pJour; ctx.fillStyle = C.blanc;
  ctx.fillText(JOURS[d.getDay()].toUpperCase(), xt, yj + capJour);
  if (hor) {
    ctx.font = pHor; ctx.fillStyle = C.creme;
    ctx.fillText(hor, xt, yj + capJour + ecart + capHor);
  }
  ctx.restore();
}

function bJours(ctx, jours, { hMax = 150, largeur = 900, gap = 22, hTotalMax = 520 } = {}) {
  jours = jours.filter(j => laDate(j.date)).sort((a, b) => laDate(a.date) - laDate(b.date));
  if (!jours.length) return null;
  const h = Math.min(hMax, (hTotalMax - gap * (jours.length - 1)) / jours.length);
  return {
    h: jours.length * h + (jours.length - 1) * gap,
    dessiner(y) { jours.forEach((j, i) => carteJour(ctx, j, W / 2 - largeur / 2, y + i * (h + gap), largeur, h)); },
  };
}

// ---------------------------------------------------------------- modèles
function joursTries(d) {
  return (d.jours || []).filter(j => laDate(j.date)).sort((a, b) => laDate(a.date) - laDate(b.date));
}

function dessinerAnnonce(ctx, d, o, img) {
  decor(ctx, 11);
  logo(ctx, img);
  const jours = joursTries(d);
  empiler(ctx, [
    bPilule(ctx, o.pilule || 'On y sera !'),
    espace(64),
    bTitre(ctx, deuxLignes(d.nom), { max: 215 }),
    espace(52),
    bIconeTexte(ctx, 'lieu', d.lieu, { taille: 82 }),
    d.adresse ? espace(22) : null,
    bTexte(ctx, d.adresse, { taille: 34 }),
    espace(52),
    bJours(ctx, jours, { hMax: 140, hTotalMax: 470 }),
    espace(44),
    bTexte(ctx, d.accroche, { taille: 38, couleur: C.gris }),
  ]);
}

function dessinerRebours(ctx, d, o, img) {
  decor(ctx, 23);
  logo(ctx, img);
  const jours = joursTries(d);
  const n = Math.max(1, Math.min(99, Number(o.n) || 1));
  const premier = jours[0];
  const detail = premier
    ? [majuscule(JOURS[laDate(premier.date).getDay()]) + ' ' + laDate(premier.date).getDate(),
       horaires(premier.horaires), premier.mention].filter(Boolean).join(' · ')
    : '';
  empiler(ctx, [
    bPilule(ctx, n === 1 ? "C'est demain !" : 'Compte à rebours'),
    espace(70),
    bTitre(ctx, [`J-${n}`], { couleurs: [C.ambre], lueur: [true], max: 470 }),
    espace(70),
    bTitre(ctx, deuxLignes(d.nom), { couleurs: [C.blanc, C.blanc], lueur: [false, false], max: 130, interligne: 0.22 }),
    espace(40),
    bIconeTexte(ctx, 'lieu', d.lieu, { taille: 70, couleur: C.ambre }),
    espace(56),
    bIconeTexte(ctx, 'calendrier', plageDates(jours), { taille: 58, couleur: C.blanc, couleurIcone: C.gris }),
    detail && jours.length > 1 ? espace(26) : null,
    jours.length > 1 ? bTexte(ctx, detail ? 'Ouverture ' + detail.replace(/^./, c => c.toLowerCase()) : '', { taille: 36 }) : null,
  ]);
}

function titreDuJour(d, o) {
  const jours = joursTries(d);
  const i = Math.min(Math.max(0, Number(o.jour) || 0), Math.max(0, jours.length - 1));
  const j = jours[i];
  let choix = o.titre || 'auto';
  if (choix === 'auto') {
    const soir = (heureDebut(j?.horaires) ?? 0) >= 17 || /nocturne/i.test(j?.mention || '');
    choix = soir ? 'soir' : (jours.length > 1 && i === jours.length - 1 ? 'dernier' : 'aujourdhui');
  }
  const titres = {
    soir: ["C'est", 'ce soir !'],
    aujourdhui: ["C'est", "aujourd'hui !"],
    dernier: ['Dernier', 'jour !'],
    weekend: ['Tout le', 'week-end !'],
  };
  return { j, lignes: titres[choix] || titres.aujourdhui };
}

function dessinerJour(ctx, d, o, img) {
  decor(ctx, 37);
  logo(ctx, img);
  const { j, lignes } = titreDuJour(d, o);
  const date = j ? laDate(j.date) : null;
  const hor = horaires(j?.horaires);
  empiler(ctx, [
    date ? bPilule(ctx, dateLongue(date)) : null,
    espace(64),
    bTitre(ctx, lignes, { max: 250 }),
    espace(hor ? 70 : 60),
    hor ? bIconeTexte(ctx, 'horloge', hor, { taille: 120, couleur: C.creme }) : null,
    hor && j?.mention ? espace(34) : null,
    hor && j?.mention ? bPilule(ctx, j.mention, { taille: 26 }) : null,
    hor ? espace(70) : null,
    bTitre(ctx, [d.nom], { couleurs: [C.blanc], lueur: [false], max: 92 }),
    espace(30),
    bIconeTexte(ctx, 'lieu', d.lieu, { taille: 76, couleur: C.ambre }),
    d.adresse ? espace(22) : null,
    bTexte(ctx, d.adresse, { taille: 34 }),
    espace(56),
    bTexte(ctx, d.accroche, { taille: 38 }),
  ]);
}

function dessinerStand(ctx, d, o, img) {
  decor(ctx, 41);
  logo(ctx, img);
  const items = (d.stand || []).filter(it => String(it.nom || '').trim()).slice(0, 5);
  const hRang = items.length > 3 ? 128 : 150, gap = 20, largeur = 900;
  const liste = {
    h: items.length ? items.length * hRang + (items.length - 1) * gap : 0,
    dessiner(y) {
      items.forEach((it, i) => {
        const x = W / 2 - largeur / 2, yy = y + i * (hRang + gap);
        ctx.save();
        rr(ctx, x, yy, largeur, hRang, 28);
        ctx.fillStyle = 'rgba(30,26,22,0.94)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = C.filet; ctx.stroke();
        etincelle(ctx, x + 64, yy + hRang / 2, 20, C.ambre);
        const xt = x + 120, lt = largeur - 150;
        const desc = String(it.desc || '').trim();
        const tNom = tailleQuiTient(ctx, [it.nom.toUpperCase()], desc ? 58 : 66, lt);
        const pNom = `${tNom}px ${DISPLAY}`, capNom = hauteurCap(ctx, pNom);
        const pDesc = `500 30px ${TEXTE}`, capDesc = desc ? hauteurCap(ctx, pDesc) : 0;
        const ec = desc ? 20 : 0;
        const y0 = yy + (hRang - capNom - ec - capDesc) / 2;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = pNom; ctx.fillStyle = C.blanc;
        ctx.fillText(it.nom.toUpperCase(), xt, y0 + capNom);
        if (desc) {
          ctx.font = pDesc; ctx.fillStyle = C.gris;
          ctx.fillText(couper(ctx, desc, lt)[0], xt, y0 + capNom + ec + capDesc);
        }
        ctx.restore();
      });
    },
  };
  const jours = joursTries(d);
  const pied = [d.nom, d.lieu, plageCourte(jours)].filter(Boolean).join(' · ');
  empiler(ctx, [
    bPilule(ctx, o.pilule || 'Sur notre stand'),
    espace(64),
    bTitre(ctx, ['À déguster', 'au stand'], { max: 200 }),
    espace(64),
    liste,
    espace(56),
    bTexte(ctx, pied, { taille: 32, couleur: C.gris }),
  ]);
}

function dessinerMerci(ctx, d, o, img) {
  decor(ctx, 53);
  logo(ctx, img, 170);
  empiler(ctx, [
    bPilule(ctx, 'Joyeuses fêtes'),
    espace(70),
    bTitre(ctx, ['Merci'], { couleurs: [C.ambre], lueur: [true], max: 340 }),
    espace(44),
    bTitre(ctx, [d.lieu ? `${d.lieu} !` : ''], { couleurs: [C.blanc], lueur: [false], max: 150 }),
    espace(70),
    bTexte(ctx, d.merci, { taille: 40, couleur: C.creme, largeur: 840, interligne: 1.45 }),
  ], ZONE.haut + 20);
}

const MODELES = [
  { id: 'annonce', nom: 'Annonce', quand: 'Dès maintenant', dessiner: dessinerAnnonce },
  { id: 'rebours', nom: 'Compte à rebours', quand: 'Les jours d’avant', dessiner: dessinerRebours },
  { id: 'jour', nom: 'Le jour J', quand: 'Le jour même', dessiner: dessinerJour },
  { id: 'stand', nom: 'Sur le stand', quand: 'Pendant le marché', dessiner: dessinerStand },
  { id: 'merci', nom: 'Merci', quand: 'Après le marché', dessiner: dessinerMerci },
];

// Rendu d'un modèle sur un canvas (créé au besoin) — utilisé par la page et l'export
function rendreStory(id, donnees, options = {}, img = null, canvas = null) {
  const m = MODELES.find(x => x.id === id);
  canvas = canvas || document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  m.dessiner(ctx, donnees, options, img);
  return canvas;
}

window.Stories = { W, H, MODELES, rendreStory, joursTries, titreDuJour, joursAvant, laDate, dateLongue, majuscule, plageDates };
