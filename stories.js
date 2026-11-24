// ===========================================================================
//  Stories Instagram des matchs diffusés au Gué des Moines
// ===========================================================================
// L'équipe décrit en une phrase les matchs à annoncer (« Toulouse – La Rochelle
// samedi et France – All Blacks dimanche ») ou demande simplement « les matchs
// du Stade Toulousain ce week-end ». L'agent (Claude) :
//   1. cherche sur le web les dates, heures et chaînes qui manquent ;
//   2. rédige l'accroche, le sous-titre et la légende Instagram ;
//   3. indique la page Wikipédia de chaque équipe, d'où l'appli tire son logo ;
//   4. renvoie le tout sous une forme fixe (outil « proposer_story »), que la
//      page transforme en image 1080 × 1920 prête à publier.
//
// Rien n'est publié automatiquement : la page affiche la proposition, l'équipe
// la corrige si besoin, puis télécharge ou partage l'image.
//
// Variables d'environnement :
//   ANTHROPIC_API_KEY  clé API Anthropic (déjà utilisée pour la lecture des bons)
//   MODELE_STORIES     facultatif, modèle à utiliser (défaut : claude-opus-5-5)

import Anthropic from '@anthropic-ai/sdk';

const MODELE = process.env.MODELE_STORIES || 'claude-opus-5-5';
const MAX_DEMANDE = 1500;
const MAX_REPRISES = 4;          // reprises d'un tour mis en pause par la recherche web
const MAX_MATCHS = 6;            // au-delà, la story devient illisible

const jourParis = () => new Date().toLocaleDateString('fr-FR', {
  timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const isoParis = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

// Consignes stables (aucune date ici : la date du jour part dans le message,
// pour que ce bloc reste identique d'une demande à l'autre et soit mis en cache).
const CONSIGNES = `Tu es le community manager du Gué des Moines, brasserie artisanale et brewpub à Bruguières, au nord de Toulouse. Le brewpub diffuse des matchs sur écran (rugby surtout — Stade Toulousain, Top 14, Champions Cup, XV de France, Tournoi des Six Nations — mais aussi football, notamment le Toulouse FC et l'équipe de France, et les grands événements sportifs). Tu prépares des stories Instagram qui annoncent ces diffusions.

Ce que tu fais pour chaque demande :
1. Identifie les matchs demandés. Si la demande est vague (« les matchs de Toulouse ce week-end »), retrouve les rencontres concernées.
2. Vérifie avec la recherche web la date, l'heure du coup d'envoi (heure de Paris) et la chaîne qui diffuse, dès qu'une de ces informations manque ou n'est pas certaine. Privilégie les sources officielles (site de la ligue ou du club, programme TV). Une ou deux recherches suffisent en général.
3. N'invente jamais une heure, une date ou une chaîne : si tu ne la trouves pas, laisse le champ vide et signale-le dans « remarques ».
4. Termine TOUJOURS en appelant l'outil proposer_story, une seule fois, avec la story complète. N'écris pas la story en texte libre.

Règles de rédaction :
- Ton direct, chaleureux, convivial, en français. Tutoiement collectif possible (« venez », « on vous attend »).
- « titre » : accroche très courte et percutante (3 à 6 mots, 28 caractères maximum), elle sera affichée en grandes majuscules. Exemples : « LE CHOC DU WEEK-END », « CE SOIR, ON VIBRE », « 3 MATCHS, 1 SEUL QG ».
- « sousTitre » : une phrase courte (60 caractères maximum).
- « badge » : 2 à 4 mots en majuscules, par exemple « DIFFUSION EN DIRECT », « ÉCRAN GÉANT », « CE SOIR AU GUÉ ».
- Noms d'équipes : forme courte et usuelle (« Stade Toulousain » ou « Toulouse », « La Rochelle », « France », « Afrique du Sud »), sans sponsor.
- « offre » : uniquement si la demande mentionne une offre, un prix ou une bière à mettre en avant. N'invente jamais de prix ni de promotion. Sinon, une invitation courte sans engagement commercial (« Venez tôt, ça va être plein ! », « Bière fraîche & ambiance garantie »).
- « couleurDomicile » / « couleurExterieur » : couleur principale du maillot de chaque équipe en hexadécimal (#RRGGBB), par exemple #E30613 pour le rouge du Stade Toulousain, #FFD100 pour le jaune de La Rochelle, #002395 pour le bleu de France. Si tu ne sais pas, mets "".
- « wikiDomicile » / « wikiExterieur » : titre exact de l'article Wikipédia en français consacré au club ou à la sélection (pas à une saison, un joueur ou un match) ; l'appli s'en sert pour afficher le logo. Exemples : « Stade toulousain », « Stade rochelais », « Union Bordeaux Bègles », « Équipe de France de rugby à XV », « Équipe d'Afrique du Sud de rugby à XV », « Toulouse Football Club », « Olympique de Marseille ». Si tu n'es pas sûr, mets "".
- « format » : "affiche" pour un seul match mis en avant, "programme" à partir de deux matchs (${MAX_MATCHS} au maximum, les plus importants d'abord dans l'ordre chronologique).
- « legende » : légende Instagram de 2 à 4 lignes avec quelques emojis, qui reprend les matchs et invite à venir au Gué des Moines à Bruguières, suivie de 5 à 8 hashtags pertinents (#LeGueDesMoines #Bruguieres #Toulouse, le sport, la compétition, les équipes).
- « remarques » : ce que l'équipe doit vérifier avant de publier (heure non confirmée, chaîne incertaine…), ou "" si tout est sûr.
- « sources » : les pages web utilisées pour vérifier les horaires (titre et adresse), liste vide si aucune.`;

// Forme imposée de la réponse. strict: true garantit un objet conforme : la
// page peut le dessiner sans contrôles défensifs à chaque champ.
const OUTIL_STORY = {
  name: 'proposer_story',
  description: "Transmet la story Instagram terminée (textes, matchs, légende) à l'appli, qui en fait l'image. À appeler une seule fois, à la fin, quand toutes les informations sont réunies.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['format', 'badge', 'titre', 'sousTitre', 'matchs', 'offre', 'legende', 'remarques', 'sources'],
    properties: {
      format: { type: 'string', enum: ['affiche', 'programme'] },
      badge: { type: 'string', description: '2 à 4 mots en majuscules' },
      titre: { type: 'string', description: 'Accroche, 28 caractères maximum' },
      sousTitre: { type: 'string', description: 'Une phrase, 60 caractères maximum' },
      matchs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sport', 'competition', 'domicile', 'exterieur', 'date', 'heure', 'diffuseur', 'couleurDomicile', 'couleurExterieur', 'wikiDomicile', 'wikiExterieur'],
          properties: {
            sport: { type: 'string', enum: ['rugby', 'football', 'autre'] },
            competition: { type: 'string', description: 'Ex. « Top 14 · 10e journée », « Six Nations »' },
            domicile: { type: 'string' },
            exterieur: { type: 'string' },
            date: { type: 'string', description: 'AAAA-MM-JJ, ou "" si inconnue' },
            heure: { type: 'string', description: 'HH:MM heure de Paris, ou "" si inconnue' },
            diffuseur: { type: 'string', description: 'Chaîne, ex. « Canal+ », « France 2 », ou ""' },
            couleurDomicile: { type: 'string', description: '#RRGGBB ou ""' },
            couleurExterieur: { type: 'string', description: '#RRGGBB ou ""' },
            wikiDomicile: { type: 'string', description: 'Titre de l\'article Wikipédia (fr) de l\'équipe, ou ""' },
            wikiExterieur: { type: 'string', description: 'Titre de l\'article Wikipédia (fr) de l\'équipe, ou ""' },
          },
        },
      },
      offre: { type: 'string' },
      legende: { type: 'string' },
      remarques: { type: 'string' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['titre', 'url'],
          properties: { titre: { type: 'string' }, url: { type: 'string' } },
        },
      },
    },
  },
};

// --- Nettoyage de la proposition : longueurs bornées, formats contrôlés ---
const texte = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_COULEUR = /^#[0-9a-fA-F]{6}$/;
const RE_TITRE_WIKI = /^[^#<>[\]{}|\n\r]{2,120}$/;
const titreWiki = v => (RE_TITRE_WIKI.test(String(v ?? '').trim()) ? String(v).trim() : '');

function nettoyer(p) {
  const matchs = (Array.isArray(p.matchs) ? p.matchs : []).slice(0, MAX_MATCHS).map(m => ({
    sport: ['rugby', 'football', 'autre'].includes(m.sport) ? m.sport : 'autre',
    competition: texte(m.competition, 50),
    domicile: texte(m.domicile, 40),
    exterieur: texte(m.exterieur, 40),
    date: RE_DATE.test(m.date) ? m.date : '',
    heure: RE_HEURE.test(String(m.heure).replace('h', ':')) ? String(m.heure).replace('h', ':') : '',
    diffuseur: texte(m.diffuseur, 30),
    couleurDomicile: RE_COULEUR.test(m.couleurDomicile) ? m.couleurDomicile.toUpperCase() : '',
    couleurExterieur: RE_COULEUR.test(m.couleurExterieur) ? m.couleurExterieur.toUpperCase() : '',
    wikiDomicile: titreWiki(m.wikiDomicile),
    wikiExterieur: titreWiki(m.wikiExterieur),
  }));
  return {
    format: matchs.length > 1 ? 'programme' : 'affiche',
    badge: texte(p.badge, 30),
    titre: texte(p.titre, 40),
    sousTitre: texte(p.sousTitre, 80),
    matchs,
    offre: texte(p.offre, 60),
    legende: String(p.legende ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2200),
    remarques: texte(p.remarques, 600),
    sources: (Array.isArray(p.sources) ? p.sources : [])
      .filter(s => /^https?:\/\//.test(s?.url ?? ''))
      .slice(0, 6)
      .map(s => ({ titre: texte(s.titre, 120) || s.url, url: String(s.url).slice(0, 500) })),
  };
}

function messageErreur(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'clé API Anthropic refusée — vérifiez ANTHROPIC_API_KEY dans Vercel.';
  if (err instanceof Anthropic.RateLimitError) return "trop de demandes en même temps, réessayez dans une minute.";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "l'agent a mis trop de temps à répondre, réessayez.";
  if (err instanceof Anthropic.APIConnectionError) return "impossible de joindre l'API Anthropic.";
  if (err instanceof Anthropic.APIError) return `API Anthropic (${err.status ?? '?'}) : ${err.message}`;
  return err.message;
}

// ---------------------------------------------------------------------------
//  Logos des équipes (Wikipédia)
// ---------------------------------------------------------------------------
// Le logo d'un club est l'image principale de son article Wikipédia. Le serveur
// la télécharge et la renvoie lui-même : servie depuis notre domaine, l'image
// peut être dessinée dans la story sans bloquer l'export (règle CORS du canevas).
const UA_WIKI = 'StoriesMatchs/1.0 (outil interne)';   // Wikimedia exige un User-Agent explicite
const HOTES_IMAGES = new Set(['thumb.wikimedia.org', 'upload.wikimedia.org']);
const cacheLogos = new Map();                            // titre → { logo, a }
const DUREE_CACHE = 24 * 3600 * 1000;

async function logoWikipedia(titre) {
  const enCache = cacheLogos.get(titre);
  if (enCache && Date.now() - enCache.a < DUREE_CACHE) return enCache.logo;

  const url = new URL('https://fr.wikipedia.org/w/api.php');
  for (const [k, v] of Object.entries({
    action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '400',
    pilicense: 'any', redirects: '1', format: 'json', formatversion: '2', titles: titre,
  })) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { 'User-Agent': UA_WIKI }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Wikipédia HTTP ${r.status}`);
  const source = (await r.json())?.query?.pages?.[0]?.thumbnail?.source;

  let logo = null;
  const adresse = source ? new URL(source) : null;
  if (adresse && adresse.protocol === 'https:' && HOTES_IMAGES.has(adresse.hostname)) {
    const ri = await fetch(adresse, { headers: { 'User-Agent': UA_WIKI }, signal: AbortSignal.timeout(8000) });
    const type = (ri.headers.get('content-type') ?? '').split(';')[0];
    if (ri.ok && /^image\/(png|jpeg|webp|gif)$/.test(type)) {
      const octets = Buffer.from(await ri.arrayBuffer());
      if (octets.length <= 2_000_000) logo = { type, octets };
    }
  }
  if (cacheLogos.size >= 300) cacheLogos.delete(cacheLogos.keys().next().value);
  cacheLogos.set(titre, { logo, a: Date.now() });   // l'absence de logo est aussi mémorisée
  return logo;
}

const CONSIGNES_TITRES = "Pour chaque équipe sportive de la liste, donne le titre exact de l'article Wikipédia en français consacré au club ou à la sélection nationale (jamais une saison, un joueur, un match ou une ville). Exemples : « Stade toulousain », « Stade rochelais », « Union Bordeaux Bègles », « Équipe de France de rugby à XV », « Équipe d'Irlande de rugby à XV », « Toulouse Football Club », « Olympique de Marseille », « Paris Saint-Germain Football Club ». Garde l'ordre de la liste ; mets une chaîne vide si tu n'es pas sûr.";
const SCHEMA_TITRES = {
  type: 'object',
  additionalProperties: false,
  required: ['titres'],
  properties: { titres: { type: 'array', items: { type: 'string' } } },
};

export function monterStories(app) {
  // Le client n'est créé qu'à la première demande : sans clé, le reste de
  // l'appli démarre normalement et seule cette route répond « non configuré ».
  let client = null;

  app.post('/api/stories/preparer', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: "Agent non configuré : ajoutez la variable d'environnement ANTHROPIC_API_KEY (clé API Anthropic) dans les réglages Vercel du projet." });
    }
    const demande = String(req.body?.demande ?? '').trim().slice(0, MAX_DEMANDE);
    const rechercheWeb = req.body?.rechercheWeb !== false;
    if (demande.length < 3) return res.status(400).json({ error: 'Décrivez les matchs à annoncer.' });

    // Vercel coupe la fonction à 300 s : on laisse de la marge pour répondre.
    client ??= new Anthropic({ timeout: 240_000, maxRetries: 1 });

    const tools = [OUTIL_STORY];
    if (rechercheWeb) {
      tools.unshift({
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 6,
        user_location: { type: 'approximate', city: 'Toulouse', region: 'Occitanie', country: 'FR', timezone: 'Europe/Paris' },
      });
    }

    const messages = [{
      role: 'user',
      content: `Nous sommes le ${jourParis()} (${isoParis()}).` +
        (rechercheWeb ? '' : " La recherche web est désactivée : n'utilise que les informations de la demande et laisse vide ce qui manque.") +
        `\n\nDemande de l'équipe :\n${demande}`,
    }];

    const debut = Date.now();
    try {
      let proposition = null;
      for (let tour = 0; tour <= MAX_REPRISES + 1 && !proposition; tour++) {
        const r = await client.beta.messages.create({
          model: MODELE,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',        // un refus du modèle principal est rejoué sur un modèle de secours
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: CONSIGNES, cache_control: { type: 'ephemeral' } }],
          tools,
          tool_choice: { type: 'auto' },
          messages,
        });

        if (r.stop_reason === 'refusal') {
          throw new Error("l'agent a refusé cette demande — reformulez-la.");
        }
        const appel = r.content.find(b => b.type === 'tool_use' && b.name === 'proposer_story');
        if (appel) { proposition = appel.input; break; }

        messages.push({ role: 'assistant', content: r.content });
        if (r.stop_reason === 'pause_turn') continue;   // la recherche web reprend là où elle s'est arrêtée
        if (r.stop_reason === 'max_tokens') throw new Error('réponse trop longue, simplifiez la demande.');
        // Fin de tour sans la story : on la redemande une fois, sans nouvelle recherche.
        messages.push({ role: 'user', content: "Appelle maintenant l'outil proposer_story avec la story complète, à partir de ce que tu as déjà trouvé." });
      }
      if (!proposition) throw new Error("l'agent n'a pas rendu de story, réessayez.");

      const story = nettoyer(proposition);
      if (!story.matchs.length) {
        return res.status(422).json({ error: "Aucun match identifié dans la demande. Précisez les équipes ou la compétition.", story });
      }
      console.log(`stories: ${story.matchs.length} match(s) en ${Math.round((Date.now() - debut) / 1000)} s`);
      res.json({ story });
    } catch (err) {
      console.error('stories:', err.message);
      res.status(502).json({ error: 'Préparation impossible : ' + messageErreur(err) });
    }
  });

  // Logo d'une équipe, à partir du titre de son article Wikipédia
  app.get('/api/stories/logo', async (req, res) => {
    const titre = titreWiki(req.query.page);
    if (!titre) return res.status(400).json({ error: 'Titre de page invalide' });
    try {
      const logo = await logoWikipedia(titre);
      if (!logo) return res.status(404).json({ error: 'Aucun logo sur cette page' });
      res.set('Content-Type', logo.type);
      res.set('Cache-Control', 'private, max-age=604800');
      res.send(logo.octets);
    } catch (err) {
      console.error('stories/logo:', err.message);
      res.status(502).json({ error: 'Wikipédia injoignable' });
    }
  });

  // Titres Wikipédia d'équipes saisies à la main (pour retrouver leur logo)
  app.post('/api/stories/logos', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Agent non configuré.' });
    const equipes = (Array.isArray(req.body?.equipes) ? req.body.equipes : []).slice(0, 12)
      .map(e => ({ nom: texte(e?.nom, 40), sport: ['rugby', 'football'].includes(e?.sport) ? e.sport : 'sport non précisé' }))
      .filter(e => e.nom.length >= 2);
    if (!equipes.length) return res.status(400).json({ error: 'Aucune équipe à chercher.' });

    client ??= new Anthropic({ timeout: 240_000, maxRetries: 1 });
    try {
      const r = await client.beta.messages.create({
        model: MODELE,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA_TITRES } },
        system: CONSIGNES_TITRES,
        messages: [{ role: 'user', content: equipes.map((e, i) => `${i + 1}. ${e.nom} (${e.sport})`).join('\n') }],
      });
      if (r.stop_reason === 'refusal') throw new Error('demande refusée');
      const brut = r.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const titres = JSON.parse(brut).titres ?? [];
      res.json({ titres: equipes.map((_, i) => titreWiki(titres[i])) });
    } catch (err) {
      console.error('stories/logos:', err.message);
      res.status(502).json({ error: 'Recherche des logos impossible : ' + messageErreur(err) });
    }
  });
}
