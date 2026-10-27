# Sections Shopify — Le Gué des Moines

Des sections Liquid sur mesure pour la boutique **leguedesmoines.com**, aux couleurs de la marque : fond sombre, accent ambré, gros titres compressés, badges pilule.

Elles sont autonomes. Elles n'ont besoin ni d'application ni de jQuery et fonctionnent sur n'importe quel thème Shopify 2.0, dont votre thème actuel « LGDM V2 ». Dans l'éditeur de thème, elles se trouvent sous **Ajouter une section → GDM · …**. L'habillage du reste du site (voir « Tout le site au style GDM ») modifie en plus quelques fichiers du thème Kalles.

## Les sections

| Fichier | Nom dans l'éditeur | Ce qu'elle fait |
|---|---|---|
| `gdm-hero.liquid` | GDM · Bannière d'accueil | Grand titre, image, image mobile ou vidéo de fond, 2 boutons, bandeau note + chiffres, tampon rotatif |
| `gdm-bandeau-defilant.liquid` | GDM · Bandeau défilant | Texte géant en défilement continu, séparateurs houblon, épi ou étoile, option « bandeaux croisés » |
| `gdm-bieres.liquid` | GDM · Nos bières | Cartes bières en carrousel ou en grille : degré, IBU, jauge d'amertume, choix 33 cL / 75 cL, ajout au panier direct |
| `gdm-histoire.liquid` | GDM · Notre histoire | Photo + médaillon + tampon « 2016 », texte, points forts avec icônes |
| `gdm-chiffres.liquid` | GDM · Chiffres clés | Grands chiffres orange animés au défilement |
| `gdm-avis.liquid` | GDM · Avis clients | Note globale, pilules de chiffres, carrousel d'avis (demi-étoiles, note exacte « 4,75 / 5 », logo, encart d'appel à l'action) |
| `gdm-promo.liquid` | GDM · Promo + compteur | Bannière promo (Noël, sortie de brassin…) avec compte à rebours à l'heure de Paris |
| `gdm-evenements.liquid` | GDM · Agenda | Concerts, quiz, dégustations ; les dates passées disparaissent toutes seules |
| `gdm-brewpub.liquid` | GDM · Venir au brewpub | Horaires avec statut « Ouvert / Fermé » en direct, adresse, itinéraire, carte Google chargée au clic |
| `gdm-faq.liquid` | GDM · FAQ | Accordéon + encart contact, données structurées FAQ pour Google |
| `gdm-univers.liquid` | GDM · Univers | Cartes numérotées en carrousel (brasserie, brewpub, e-shop…) avec photo, points clés et bouton |
| `gdm-service.liquid` | GDM · Service | Présentation d'un service (location de tireuse) : photo encadrée, chiffres, étiquettes, offres, 2 boutons |
| `gdm-articles.liquid` | GDM · Articles | Articles de blog choisis à la main, ou les derniers articles d'un blog ; en carrousel ou en grille avec filtres par étiquette (page Blog) ; sur un blog ou un article, reprend le blog consulté |
| `gdm-newsletter.liquid` | GDM · Newsletter | Inscription à la newsletter (formulaire client Shopify), messages de succès et d'erreur |
| `gdm-atouts.liquid` | GDM · Atouts | Rangée d'atouts (paiement sécurisé, livraison, retrait…) avec icônes ou images |
| `gdm-apps.liquid` | GDM · Application | En-tête GDM autour d'un bloc d'application (flux Instagram Instafeed…) |
| `gdm-image.liquid` | GDM · Image | Grande image encadrée, cliquable |
| `gdm-stories.liquid` | GDM · Stories | Rangée de ronds façon Instagram ; un appui ouvre des écrans plein format qui défilent seuls (appui à gauche/droite, appui long = pause, glisser = story suivante, glisser vers le bas = fermer). Écrans photo + texte + bouton, ou bière avec prix et ajout au panier. Blocs « Story (rond) » suivis de leurs blocs « Écran ». |

Fichiers partagés (obligatoires) :

- `snippets/gdm-assets.liquid`, `gdm-icon.liquid`, `gdm-stars.liquid`, `gdm-stamp.liquid`
- `assets/gdm-sections.css`, `gdm-sections.js`, `gdm-anton-latin.woff2`, `gdm-inter-latin.woff2`

Habillage de tout le site : `snippets/gdm-site.liquid`, `snippets/gdm-page-skin.liquid`, `assets/gdm-site.css` (chargés par `layout/theme.liquid`).

## Installation (≈ 10 minutes)

> Travaillez d'abord sur une **copie** du thème : *Boutique en ligne → Thèmes → ⋯ → Dupliquer*. Publiez la copie quand tout vous plaît.

### Option 1 — depuis l'administration Shopify

1. *Boutique en ligne → Thèmes → ⋯ (sur la copie) → Modifier le code*.
2. **Assets → Ajouter un nouvel élément → Importer un fichier** : importez les 4 fichiers du dossier `assets/`.
3. **Snippets → Ajouter un nouveau snippet** : créez `gdm-assets`, `gdm-icon`, `gdm-stars` et `gdm-stamp`, puis collez le contenu de chaque fichier.
4. **Sections → Ajouter une nouvelle section** : créez chaque section avec le même nom que le fichier (par exemple `gdm-hero`), puis collez son contenu.
5. *Personnaliser* → **Ajouter une section** → choisissez une section « GDM · … ».

### Option 2 — avec Shopify CLI

```bash
cd shopify
shopify theme push --store 5bdc8a-32.myshopify.com --theme "<id de la copie>" \
  --only "sections/gdm-*" --only "snippets/gdm-*" --only "assets/gdm-*" \
  --only "templates/*.json" --only "sections/footer.liquid" \
  --only "layout/theme.liquid" --only "locales/fr.json"
```

Avant de pousser les modèles (`templates/*.json`) ou `locales/fr.json`, récupérez la version du thème (`shopify theme pull --only …`) pour ne pas écraser une modification faite dans l'éditeur. `layout/theme.liquid`, `sections/footer.liquid` et `locales/fr.json` concernent toutes les pages : après publication, contrôlez une fiche produit, le panier, un article et le paiement.

## À compléter avant de publier

Les textes par défaut sont des **exemples** : remplacez-les par vos vraies informations.

- **Horaires** (Venir au brewpub) : les horaires pré-remplis sont fictifs. Un bloc « Jour » par jour, au format `17:00`. Une fermeture après minuit est bien gérée.
- **Avis clients** : collez de vrais avis (Google, Facebook, Untappd…) avec le prénom de leur auteur. N'inventez jamais d'avis : c'est une pratique commerciale trompeuse, sanctionnée par la DGCCRF.
- **Chiffres** (bannière, avis, chiffres clés) : vérifiez la note, le nombre de bières, etc.
- **Agenda** : les trois événements sont des exemples datés de novembre et décembre 2026.
- **Liens** des boutons : renseignez-les dans l'éditeur (contact, Instagram, fiche Google…).

### Style de bière sur les cartes (conseillé)

Le métachamp Shopify « Style de bière » de vos fiches contient « Doux / Lisse » pour toutes les bières : il n'est donc pas affiché. Pour afficher « NEIPA », « West Coast IPA », « Sour framboise »… au-dessus du nom :

1. *Paramètres → Métachamps et métaobjets → Produits → Ajouter une définition*.
2. Nom : `Style`, espace de nommage et clé : `custom.style`, type : **Texte sur une seule ligne**.
3. Remplissez-le sur chaque fiche bière. La section le lit automatiquement (réglage « Petit texte orange au-dessus du nom »).

Les métachamps existants `custom.degre` et `custom.ibu` sont déjà utilisés. La **jauge d'amertume** est calculée à partir de l'IBU : vérifiez les fiches où l'IBU vaut 10 alors qu'il s'agit d'IPA (Roi de Cœur, Super Power, Dame de Cœur).

## Notes techniques

- **Ajout au panier** : formulaire natif `/cart/add`, le chemin le plus fiable. Il ne dépend pas du panier AJAX du thème.
- **Polices** : Anton et Inter sont hébergées dans le thème, sans aucune requête vers Google Fonts. Leurs licences (SIL OFL 1.1) sont dans `licences-polices/`.
- **Carte Google** : elle ne se charge qu'au clic du visiteur. Aucun cookie Google n'est déposé avant.
- **Accessibilité** : les animations sont coupées si le visiteur a activé « réduire les animations ». Le focus clavier est visible, les carrousels se pilotent au clavier, les icônes sont décoratives et les boutons sont libellés.
- **Éditeur de thème** : les animations d'apparition y sont désactivées et les événements passés restent visibles, grisés, pour pouvoir les modifier.
- **Personnalisation** : chaque section a ses réglages de couleur de fond, de couleur d'accent et de marges. Tout le CSS est préfixé `gdm-` : aucun risque de conflit avec le thème.
- Validé avec **Shopify Theme Check** : 0 erreur, 0 avertissement.

## Page d'accueil installée sur la copie du thème

`templates/index.json` est la page d'accueil installée sur le thème « LGDM V2 - nouvelles sections GDM » (copie non publiée), avec les vrais contenus du site.

**Format story, plus compact.** Ordre : bannière → stories → bières → atouts → brewpub → location de tireuse → avis → FAQ → newsletter → Instagram. La page passe d'environ 15 à 6,5 écrans sur ordinateur et de 20 à 8 écrans sur téléphone.

- **Stories** (sous la bannière) : Noël, E-shop (3 bières avec ajout au panier), Brasserie (histoire, visites guidées), Untappd (note et 3 avis), Le blog (5 articles).
- **Sections masquées, pas supprimées** (réactivables en un clic dans l'éditeur), car leur contenu est repris dans les stories ou ailleurs sur la page : promo Noël, univers, histoire, Untappd, articles, grande image, bandeau défilant, le H2 SEO caché et une section d'applications vide.
- **Doublons retirés** : chiffres « 100 % » et « 2016 » de la bannière (déjà dans le badge et le titre), atout « 100 % artisanal », cartes « Fût 20L / 30L » (déjà en chiffres sur la photo), encadré contact de la FAQ (déjà dans le brewpub), FAQ fermée par défaut (les horaires sont juste au-dessus).
- **Compaction** : marges de section 56 px (35 px sur téléphone), titres et chapôs plus petits, boutons de 46 px (48 px sur téléphone, deux boutons côte à côte), horaires du brewpub sur deux colonnes, carte Google masquée sur téléphone (le bouton « Itinéraire » ouvre Maps).
- **Pied de page** (`sections/footer.liquid`, fichier du thème modifié sur la copie) : colonnes de liens en accordéon sur téléphone, carte de contact compacte, mentions légales lisibles, icône Instagram vers le compte du flux (@brasserieleguedesmoines).

À faire au calendrier : le 26 décembre, retirer la story « Noël » (blocs `noel` et `noel_1` de `gdm_stories`).

Les anciennes sections du thème restent intactes dans votre thème en ligne, qui n'a pas été modifié. Les anciennes sections déjà masquées ont été retirées de la copie (Shopify limite une page à 25 sections).

## Tout le site au style GDM (copie du thème)

Toutes les pages de la copie « LGDM V2 - nouvelles sections GDM » reprennent le style de l'accueil : polices Anton et Inter, orange #F0921E, fond #0D0D0D, boutons pilule, champs sombres, mise en page plus compacte. Rien n'est publié : le thème en ligne n'a pas été modifié.

| Où | Fichiers | Ce qui change |
|---|---|---|
| Tout le site | `layout/theme.liquid` (une ligne : `render 'gdm-site'`), `snippets/gdm-site.liquid`, `assets/gdm-site.css` | Couleurs, polices, boutons et champs du thème Kalles ; titres Anton ; panier latéral et suggestions sombres |
| Fiches produit | `templates/product.json` | Fiche du thème restylée, puis « Nos autres bières » (la bière affichée exclue), FAQ, Instagram |
| Collections | `templates/collection.json` | Grille GDM des bières (titre et description de la collection), Instagram |
| Pages et articles avec leur propre mise en page | `snippets/gdm-page-skin.liquid`, généré par `outils/gdm_page_skin.py` | Polices et couleurs GDM, espacements resserrés ; sur téléphone, les grilles de cartes deviennent des rangées qui défilent au doigt |
| Blog | `templates/blog.json` | Grille de tous les articles avec photo et filtres par étiquette |
| Articles | `templates/article.json` | « À lire aussi » et la gamme en carrousels sous l'article |
| Contact | `templates/page.contact.json` | Bloc brewpub (horaires du jour, adresse, téléphone, e-mail) puis formulaire |
| Galerie, recherche, 404 | `templates/page.galerie.json`, `search.json`, `404.json` | Deux photos par ligne sur mobile ; collections de démonstration retirées de la recherche ; 404 avec titre et la gamme |
| Panier | `templates/cart.json` | La page affichait le panier latéral sans son tiroir (articles et total invisibles) : vraie page panier, total mis à jour après chaque changement |
| Traductions | `locales/fr.json` | Textes d'une ancienne boutique retirés (voir ci-dessous) |

**Le contenu des pages, articles et collections n'est pas modifié** : il est enregistré dans la boutique et partagé avec le site en ligne. Leur habillage se fait depuis le thème. Si vous modifiez la mise en page d'une page dans l'administration, régénérez l'habillage :

```bash
python3 outils/gdm_page_skin.py <dossier des sources> snippets/gdm-page-skin.liquid
```

Le dossier contient un fichier HTML par contenu (`page__brewpub.html`, `article__infos~mon-article.html`, `collection__ipa.html`), copie du champ « contenu » de l'administration.

Hauteur sur téléphone, en écrans à faire défiler (site en ligne → copie) : accueil 11,2 → 7,7 ; bières artisanales 11,4 → 6,7 ; tireuse 12 → 9,3 ; brewpub 9,2 → 6,7 ; brasserie 9,4 → 6,9 ; guide de dégustation 18 → 14,3 ; blog 6,2 → 4,5 ; galerie 5,2 → 2 ; panier 3,3 → 1,4.

### Corrigé dans les traductions du thème (copie)

Ces textes s'affichent aujourd'hui sur le site en ligne et au paiement :

- Panier : « -10% avec le code : ARTPIXE » (ce code n'existe pas dans la boutique) → « Taxes incluses. Frais de port calculés à la caisse. »
- Paiement : « Pour valider avec toi‚ ton portrait : », « Livraison à domicile (4,90 €) » (la livraison standard est à 9,90 €) et « Livraison GRATUITE en Point Relais / Digital » (aucun point relais) retirés : Shopify reprend ses libellés standard.
- « Vide » → « Votre panier est vide » ; page 404 : titre « Page introuvable ».

### À corriger dans l'administration (contenus)

- Trois articles commencent par une photo hébergée sur une ancienne boutique, introuvable (erreur 404) : « L'histoire du Gué des Moines », « Pourquoi le Gué des Moines », « Le Gué des Moines s'installe dans l'ancienne briqueterie ». Remplacez la photo dans l'article.
- Aucun article n'a d'image à la une : la carte du blog reprend la première photo du texte. Une image à la une donne un meilleur cadrage.
- Restes de l'ancienne boutique : le widget d'abonnement des fiches produit renvoie vers une page de portraits, et des réglages du méga-menu du thème pointent encore vers la collection « portrait-personnalise-catoon ».

## Aperçu

`apercu-interactif.html` : ouvrez-le dans un navigateur pour essayer les sections (carrousel, 33/75 cL, compte à rebours, FAQ…). L'ajout au panier y est simulé.

`apercu-ordinateur.jpg` et `apercu-mobile.jpg` montrent toutes les sections empilées, avec vos vraies bières et vos photos.
