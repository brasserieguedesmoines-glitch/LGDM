// ===========================================================================
//  Accès : appli interne protégée, espace de commande pro par lien personnel
// ===========================================================================
// Deux publics, deux règles :
//   • l'équipe entre par un mot de passe (APP_MOT_DE_PASSE) et reçoit un
//     cookie de session signé ;
//   • un client pro n'entre que par son lien personnel. Le lien EST
//     l'identifiant : il ne donne accès qu'à SA gamme, SES prix et SES
//     commandes, et peut être désactivé à tout moment.
// Une commande pro n'est jamais envoyée directement à EasyBeer : elle attend
// dans une file « à valider », qu'un membre de l'équipe vérifie et envoie.

import crypto from 'crypto';
import PDFDocument from 'pdfkit';

const COOKIE = 'lgdm_session';
const DUREE_SESSION = 30 * 86400 * 1000;
const MOT_DE_PASSE = process.env.APP_MOT_DE_PASSE ?? '';
// Clé de signature : dédiée si fournie, sinon dérivée des secrets existants.
const CLE = crypto.createHash('sha256')
  .update(process.env.APP_SECRET || `${MOT_DE_PASSE}|${process.env.KV_REST_API_TOKEN ?? ''}|${process.env.EASYBEER_API_PASSWORD ?? ''}`)
  .digest();

const signer = v => crypto.createHmac('sha256', CLE).update(v).digest('base64url');
const egal = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const JETON_INTERNE = signer('appel-interne');

function lireCookie(req, nom) {
  const m = (req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(nom + '='));
  return m ? decodeURIComponent(m.slice(nom.length + 1)) : '';
}
function sessionValide(req) {
  const [exp, sig] = lireCookie(req, COOKIE).split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && egal(sig, signer(exp));
}

// Routes accessibles sans session : connexion, espace pro, caches CDN
// (catalogue et prix, appelés en interne et mis en cache par le CDN).
const LIBRES = [/^\/auth\//, /^\/pro\//, /^\/cache\//];

export function monterAcces(app) {
  if (!MOT_DE_PASSE) console.warn('APP_MOT_DE_PASSE absent : appli interne NON protégée');

  app.use('/api', (req, res, next) => {
    if (!MOT_DE_PASSE || LIBRES.some(r => r.test(req.path))) return next();
    const interne = req.get('x-lgdm-interne');
    if (sessionValide(req) || (interne && egal(interne, JETON_INTERNE))) {
      // Réponse personnelle : jamais en cache partagé du CDN, sans quoi elle
      // serait resservie à quelqu'un de non connecté.
      const orig = res.setHeader.bind(res);
      res.setHeader = (k, v) => /^cache-control$/i.test(k)
        ? orig(k, String(v).replace(/public/, 'private').replace(/,\s*(s-maxage|stale-while-revalidate)=\d+/g, ''))
        : orig(k, v);
      return next();
    }
    res.status(401).json({ error: 'Connexion requise', connexion: true });
  });

  let echecs = 0;
  app.post('/api/auth/connexion', async (req, res) => {
    if (!MOT_DE_PASSE) return res.json({ ok: true, protege: false });
    // Freine les essais en série sans bloquer l'équipe.
    await new Promise(r => setTimeout(r, Math.min(echecs, 10) * 500));
    const mdp = String(req.body?.motDePasse ?? '');
    const ok = egal(signer(mdp), signer(MOT_DE_PASSE));
    if (!ok) { echecs++; return res.status(401).json({ error: 'Mot de passe incorrect' }); }
    echecs = 0;
    const exp = String(Date.now() + DUREE_SESSION);
    res.set('Set-Cookie', `${COOKIE}=${exp}.${signer(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DUREE_SESSION / 1000}`);
    res.json({ ok: true });
  });

  app.post('/api/auth/deconnexion', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/auth/etat', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ protege: !!MOT_DE_PASSE, connecte: !MOT_DE_PASSE || sessionValide(req) });
  });
}

// ---------------------------------------------------------------------------
//  Espace pro
// ---------------------------------------------------------------------------
const CLE_LIENS = 'lgdm:pro-liens';
const CLE_CMD = 'lgdm:pro-commandes';

export function monterPro(app, d) {
  const { redis, redisActif, getProduitsClient, fetchInterne, construirePayloadCommande, easybeerPost, aDejaCommandeDesFuts } = d;

  const lireTout = async cle => {
    const plat = await redis('HGETALL', cle) ?? [];
    const out = [];
    for (let i = 1; i < plat.length; i += 2) { try { out.push(JSON.parse(plat[i])); } catch {} }
    return out;
  };
  const lire = async (cle, id) => { const v = await redis('HGET', cle, id); return v ? JSON.parse(v) : null; };
  const ecrire = (cle, id, v) => redis('HSET', cle, id, JSON.stringify(v));

  const repondre = (res, fn) => {
    if (!redisActif()) return res.status(503).json({ error: 'Base partagée non configurée' });
    return fn().catch(err => {
      console.error('pro:', err.message);
      res.status(err.status ?? 502).json({ error: err.message });
    });
  };
  const erreur = (status, message) => Object.assign(new Error(message), { status });

  async function lienValide(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token ?? '')) throw erreur(404, 'Lien inconnu');
    const l = await lire(CLE_LIENS, token);
    if (!l || !l.actif) throw erreur(404, 'Ce lien n’est plus actif. Contactez la brasserie.');
    return l;
  }

  // Catalogue d'un client : sa gamme (CHR/cavistes → classique, GMS → La
  // Bruguiéroise), avec ses prix HT de grille.
  // Le calcul est lent (grille du canal : jusqu'à une minute pour les CHR,
  // puis un prix par produit) : il est gardé 12 h dans la base partagée, donc
  // commun à toutes les instances, et préparé dès la création du lien.
  const DUREE_CATALOGUE = 12 * 3600;
  const catalogues = new Map();
  async function calculerCatalogue(req, lien) {
    const tous = await getProduitsClient(lien.idClient);
    const gamme = lien.canal === 'GMS' ? 'gms' : 'classique';
    const filtres = tous.filter(p => (p.gamme ?? 'classique') === gamme);
    const liste = filtres.length ? filtres : tous;
    // Prix demandés par paquets de 6 plutôt qu'un par un.
    const produits = [];
    for (let i = 0; i < liste.length; i += 6) {
      produits.push(...await Promise.all(liste.slice(i, i + 6).map(async p => {
        let prixHT = null;
        if (p.idStockBouteille && lien.idClientType) {
          try {
            const r = await fetchInterne(req, `/api/cache/prix/${p.idStockBouteille}/${lien.idClientType}/${lien.idClient}`);
            prixHT = typeof r?.prixHT === 'number' ? r.prixHT : null;
          } catch {}
        }
        return {
          cle: `${p.idProduit}-${p.idContenant}-${p.idLot ?? 1}`,
          idProduit: p.idProduit, idContenant: p.idContenant, idLot: p.idLot ?? 1,
          libelle: p.libelle, contenant: p.contenant, prixHT,
        };
      })));
    }
    // Fûts proposés seulement aux clients qui en ont déjà commandé.
    const futs = await aDejaCommandeDesFuts(req, lien.idClient).catch(() => null);
    return { produits, futs: futs === true };
  }
  const estFut = p => /f[uû]t|keg/i.test(`${p.contenant} ${p.libelle}`);

  // Catalogue de base (gardé 12 h), puis filtres appliqués à chaque demande :
  // fûts réservés aux habitués, et seulement ce qui est en stock maintenant.
  async function catalogueBrut(req, lien, { forcer = false } = {}) {
    const cle = `lgdm:pro-catalogue:${lien.idClient}`;
    const m = catalogues.get(lien.idClient);
    if (!forcer && m && Date.now() < m.expire) return m.cat;
    if (!forcer) {
      const v = await redis('GET', cle).catch(() => null);
      const cat = v ? JSON.parse(v) : null;
      if (cat?.produits) {           // ancien format (liste seule) : recalculé
        catalogues.set(lien.idClient, { cat, expire: Date.now() + 30 * 60 * 1000 });
        return cat;
      }
    }
    const cat = await calculerCatalogue(req, lien);
    catalogues.set(lien.idClient, { cat, expire: Date.now() + 30 * 60 * 1000 });
    if (cat.produits.length) await redis('SET', cle, JSON.stringify(cat), 'EX', DUREE_CATALOGUE).catch(() => {});
    return cat;
  }
  async function catalogue(req, lien, opts) {
    const cat = await catalogueBrut(req, lien, opts);
    let stock = null;
    try { stock = await fetchInterne(req, '/api/cache/stock-index'); } catch {}
    return cat.produits
      .filter(p => cat.futs || !estFut(p))
      // Stock illisible : on ne masque rien plutôt que de vider le catalogue.
      .filter(p => !stock || (stock[p.cle]?.quantiteDisponible ?? 0) > 0);
  }


  const vueCommande = c => ({
    id: c.id, recuLe: c.recuLe, statut: c.statut, dateSouhaitee: c.dateSouhaitee,
    commentaire: c.commentaire, totalHT: c.totalHT, numeroEasyBeer: c.numeroEasyBeer ?? null,
    motif: c.motif ?? null,
    lignes: c.lignes.map(l => ({ libelle: l.libelle, contenant: l.contenant, quantite: l.quantite, prixHT: l.prixHT })),
  });

  // --- Côté client pro (accès par lien) ---
  app.get('/api/pro/:token', (req, res) => repondre(res, async () => {
    const lien = await lienValide(req.params.token);
    const produits = await catalogue(req, lien);
    const commandes = (await lireTout(CLE_CMD))
      .filter(c => c.token === req.params.token)
      .sort((a, b) => b.recuLe - a.recuLe).slice(0, 10).map(vueCommande);
    res.set('Cache-Control', 'no-store');
    res.json({ client: lien.nom, produits, commandes });
  }));

  app.post('/api/pro/:token/commande', (req, res) => repondre(res, async () => {
    const lien = await lienValide(req.params.token);
    const produits = await catalogue(req, lien);
    const parCle = new Map(produits.map(p => [p.cle, p]));
    const demandees = Array.isArray(req.body?.lignes) ? req.body.lignes.slice(0, 60) : [];

    // Seuls les produits de SON catalogue, en quantités entières raisonnables ;
    // les prix sont ceux du serveur, jamais ceux envoyés par le navigateur.
    const lignes = [];
    for (const l of demandees) {
      const p = parCle.get(String(l?.cle ?? ''));
      const q = Number(l?.quantite);
      if (!p || !Number.isInteger(q) || q < 1 || q > 500) continue;
      lignes.push({ ...p, quantite: q });
    }
    if (!lignes.length) throw erreur(400, 'Commande vide');

    const enAttente = (await lireTout(CLE_CMD)).filter(c => c.token === req.params.token && c.statut === 'a_valider');
    if (enAttente.length >= 5) throw erreur(429, 'Trop de commandes en attente. La brasserie va les traiter.');

    const dateSouhaitee = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.dateSouhaitee ?? '') ? req.body.dateSouhaitee : null;
    const totalHT = Math.round(lignes.reduce((s, l) => s + (l.prixHT ?? 0) * l.quantite, 0) * 100) / 100;
    const cmd = {
      id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      token: req.params.token, idClient: lien.idClient, nom: lien.nom,
      canal: lien.canal, idClientType: lien.idClientType,
      lignes, totalHT, dateSouhaitee,
      commentaire: String(req.body?.commentaire ?? '').slice(0, 500),
      statut: 'a_valider', recuLe: Date.now(),
    };
    await ecrire(CLE_CMD, cmd.id, cmd);
    res.json({ ok: true, commande: vueCommande(cmd) });
  }));

  // Récapitulatif PDF d'une commande, pour le client.
  app.get('/api/pro/:token/commande/:id/recap.pdf', (req, res) => repondre(res, async () => {
    const lien = await lienValide(req.params.token);
    const c = await lire(CLE_CMD, req.params.id);
    if (!c || c.token !== req.params.token) throw erreur(404, 'Commande inconnue');
    const eur = n => n == null ? '—' : n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ') + ' €';
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="commande-gue-des-moines-${new Date(c.recuLe).toISOString().slice(0, 10)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(18).text('Brasserie du Gué des Moines');
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('Bruguières (31)');
    doc.moveDown(1.2).fillColor('#000').font('Helvetica-Bold').fontSize(14).text('Récapitulatif de commande');
    doc.font('Helvetica').fontSize(10).moveDown(0.4)
      .text(`Client : ${lien.nom}`)
      .text(`Commande du ${new Date(c.recuLe).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`)
      .text(`État : ${({ a_valider: 'reçue, en cours de vérification', envoi: 'en cours de traitement', validee: 'validée', refusee: 'non retenue' })[c.statut] ?? c.statut}`);
    if (c.dateSouhaitee) doc.text(`Livraison souhaitée : ${c.dateSouhaitee.split('-').reverse().join('/')}`);
    doc.moveDown(1);
    const x = [48, 330, 400, 480], y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    ['Produit', 'Qté', 'PU HT', 'Total HT'].forEach((t, i) => doc.text(t, x[i], y0, { width: i ? 70 : 270, align: i ? 'right' : 'left' }));
    doc.moveTo(48, y0 + 14).lineTo(548, y0 + 14).strokeColor('#bbb').stroke();
    doc.font('Helvetica').fontSize(9);
    let y = y0 + 20;
    for (const l of c.lignes) {
      if (y > 760) { doc.addPage(); y = 48; }
      doc.text(`${l.libelle} — ${l.contenant}`, x[0], y, { width: 270 });
      doc.text(String(l.quantite), x[1], y, { width: 70, align: 'right' });
      doc.text(eur(l.prixHT), x[2], y, { width: 70, align: 'right' });
      doc.text(eur(l.prixHT == null ? null : l.prixHT * l.quantite), x[3], y, { width: 70, align: 'right' });
      y = Math.max(doc.y, y + 12) + 4;
    }
    doc.moveTo(48, y).lineTo(548, y).strokeColor('#bbb').stroke();
    doc.font('Helvetica-Bold').text('Total HT indicatif', x[0], y + 8).text(eur(c.totalHT), x[3], y + 8, { width: 70, align: 'right' });
    doc.font('Helvetica').fillColor('#000');
    if (c.commentaire) doc.moveDown(1.5).text(`Commentaire : ${c.commentaire}`, 48);
    if (c.motif) doc.moveDown(0.5).text(`Motif : ${c.motif}`, 48);
    doc.moveDown(2).fontSize(8).fillColor('#666').text(
      'Document récapitulatif, non contractuel : prix HT de votre grille au moment de la commande, hors droits et consignes éventuels. '
      + 'La facture fait foi.', 48, undefined, { width: 500 });
    doc.end();
  }));

  // --- Côté équipe (session requise) ---
  app.get('/api/pro-admin/liens', (req, res) => repondre(res, async () => {
    res.set('Cache-Control', 'no-store');
    res.json((await lireTout(CLE_LIENS)).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')));
  }));

  // Un seul lien actif par client : le redemander renvoie le même.
  app.post('/api/pro-admin/liens', (req, res) => repondre(res, async () => {
    const { idClient, nom, canal, idClientType } = req.body ?? {};
    if (!Number.isInteger(idClient) || !nom) throw erreur(400, 'idClient et nom requis');
    const existant = (await lireTout(CLE_LIENS)).find(l => l.idClient === idClient && l.actif);
    if (existant && !req.body?.regenerer) {
      await catalogue(req, existant).catch(() => {});
      return res.json(existant);
    }
    if (existant) await ecrire(CLE_LIENS, existant.token, { ...existant, actif: false, desactiveLe: Date.now() });
    const lien = {
      token: crypto.randomBytes(18).toString('base64url'),
      idClient, nom: String(nom).slice(0, 120), canal: canal ?? null,
      idClientType: Number.isInteger(idClientType) ? idClientType : null,
      actif: true, creeLe: Date.now(),
    };
    await ecrire(CLE_LIENS, lien.token, lien);
    // Préparation du catalogue : le client ne subira pas le premier calcul.
    await catalogue(req, lien, { forcer: true }).catch(e => console.error('pro: catalogue', e.message));
    res.json(lien);
  }));

  app.delete('/api/pro-admin/liens/:token', (req, res) => repondre(res, async () => {
    const l = await lire(CLE_LIENS, req.params.token);
    if (!l) throw erreur(404, 'Lien inconnu');
    await ecrire(CLE_LIENS, l.token, { ...l, actif: false, desactiveLe: Date.now() });
    res.json({ ok: true });
  }));

  app.get('/api/pro-admin/commandes', (req, res) => repondre(res, async () => {
    res.set('Cache-Control', 'no-store');
    res.json((await lireTout(CLE_CMD)).sort((a, b) => b.recuLe - a.recuLe).slice(0, 300));
  }));

  // Validation : l'équipe peut ajuster les quantités (0 retire la ligne),
  // puis la commande part dans EasyBeer par le même chemin que la saisie
  // interne. Verrou « envoi » contre le double clic.
  app.post('/api/pro-admin/commandes/:id/valider', (req, res) => repondre(res, async () => {
    const c = await lire(CLE_CMD, req.params.id);
    if (!c) throw erreur(404, 'Commande inconnue');
    if (c.statut !== 'a_valider') throw erreur(409, `Commande déjà ${c.statut === 'validee' ? 'validée' : 'traitée'}`);

    const ajust = new Map((req.body?.lignes ?? []).map(l => [String(l.cle), Number(l.quantite)]));
    const lignes = c.lignes
      .map(l => ajust.has(l.cle) ? { ...l, quantite: ajust.get(l.cle) } : l)
      .filter(l => Number.isInteger(l.quantite) && l.quantite > 0);
    if (!lignes.length) throw erreur(400, 'Plus aucune ligne à envoyer');

    await ecrire(CLE_CMD, c.id, { ...c, statut: 'envoi' });
    try {
      const commentaire = ['Commande pro en ligne',
        c.dateSouhaitee ? `livraison souhaitée le ${c.dateSouhaitee.split('-').reverse().join('/')}` : '',
        c.commentaire].filter(Boolean).join(' — ');
      const payload = await construirePayloadCommande(req, {
        idClient: c.idClient, idClientType: c.idClientType, commentaire,
        lignes: lignes.map(l => ({ idProduit: l.idProduit, idContenant: l.idContenant, idLot: l.idLot, quantite: l.quantite })),
      });
      const r = await easybeerPost('/commande/enregistrer', payload);
      const fait = {
        ...c, lignes, statut: 'validee', valideLe: Date.now(),
        totalHT: Math.round(lignes.reduce((s, l) => s + (l.prixHT ?? 0) * l.quantite, 0) * 100) / 100,
        numeroEasyBeer: r?.map?.numero ?? r?.map?.id ?? null,
      };
      await ecrire(CLE_CMD, c.id, fait);
      res.json({ ok: true, commande: fait });
    } catch (e) {
      await ecrire(CLE_CMD, c.id, { ...c, statut: 'a_valider' });
      throw e;
    }
  }));

  app.post('/api/pro-admin/commandes/:id/refuser', (req, res) => repondre(res, async () => {
    const c = await lire(CLE_CMD, req.params.id);
    if (!c) throw erreur(404, 'Commande inconnue');
    if (c.statut !== 'a_valider') throw erreur(409, 'Commande déjà traitée');
    const fait = { ...c, statut: 'refusee', refuseLe: Date.now(), motif: String(req.body?.motif ?? '').slice(0, 300) };
    await ecrire(CLE_CMD, c.id, fait);
    res.json({ ok: true, commande: fait });
  }));
}
