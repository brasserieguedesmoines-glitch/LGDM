# ScrapeGraph AI — serveur MCP

Le fichier `.mcp.json` à la racine déclare le serveur MCP **scrapegraph**
([ScrapeGraphAI/scrapegraph-mcp](https://github.com/ScrapeGraphAI/scrapegraph-mcp)).
Une fois la clé API en place, Claude Code peut extraire des données structurées
depuis des pages web en langage naturel.

## 1. Prérequis : `uv`

Le serveur est un paquet Python lancé par `uvx`. Si `uv` n'est pas installé :

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Vérifier avec `uvx --version`.

## 2. Récupérer une clé API

1. Créer un compte sur [scrapegraphai.com](https://scrapegraphai.com) (plan gratuit disponible).
2. Copier la clé dans le dashboard — format `SGAI-xxxxxxxx`.

## 3. Fournir la clé à Claude Code

La clé **n'est jamais écrite dans `.mcp.json`** : le fichier référence la variable
`${SGAI_API_KEY}`, que Claude Code résout au démarrage du serveur.

Deux façons de la définir, au choix.

### Option A — variable d'environnement du shell (recommandée)

```bash
# à ajouter dans ~/.zshrc, ~/.bashrc, etc.
export SGAI_API_KEY="SGAI-xxxxxxxx"
```

Puis ouvrir un nouveau terminal avant de relancer Claude Code.

### Option B — `.claude/settings.local.json`

Ce fichier est ignoré par git (voir `.gitignore`), il ne partira donc pas sur GitHub :

```json
{
  "env": {
    "SGAI_API_KEY": "SGAI-xxxxxxxx"
  }
}
```

> ⚠️ Le `.env` du projet **ne convient pas** : il est lu par `dotenv` au démarrage
> de `server.js`, pas par Claude Code. Les serveurs MCP n'y ont pas accès.

## 4. Activer le serveur

Redémarrer Claude Code dans le dossier du projet. À la première ouverture, Claude Code
demande d'approuver les serveurs MCP déclarés dans `.mcp.json` — répondre oui.

Vérifier ensuite avec :

```
/mcp
```

`scrapegraph` doit apparaître *connected*, avec 17 outils. Le premier lancement prend
une trentaine de secondes (`uvx` télécharge et construit l'environnement), les suivants
sont quasi instantanés grâce au cache.

Outils exposés : `scrape`, `extract`, `search`, `crawl_start`, `crawl_get_status`,
`crawl_stop`, `crawl_resume`, `schema`, `credits`, `history`, `monitor_create`,
`monitor_list`, `monitor_get`, `monitor_pause`, `monitor_resume`, `monitor_delete`,
`monitor_activity`.

`credits` est le test le plus rapide pour valider la clé : il renvoie le solde du compte.

## 5. Utilisation

Décrire la cible en langage naturel, en étant le plus précis possible sur le secteur,
la localisation, le poste et les champs voulus :

```
Extrais les 50 premiers résultats Google pour "caviste Lyon" avec nom, site web et téléphone
```

```
Compare les pages de tarifs de ces 3 concurrents et résume les différences
```

Le serveur fonctionne sur à peu près n'importe quel site : annuaires, Google Maps,
sites de concurrents, forums, offres d'emploi.

## Pourquoi pas la commande Smithery ?

La commande largement relayée pour ce serveur est :

```bash
claude mcp add scrapegraph -- npx -y @smithery/cli@latest run @ScrapeGraphAI/scrapegraph-mcp --config "{\"scrapegraphApiKey\":\"…\"}"
```

Elle est obsolète (elle figure encore dans le README amont, non mis à jour) :

- le CLI Smithery v4 marque `run` comme *deprecated* — « Direct HTTP server execution
  is deprecated » ;
- ce chemin ne lance pas le serveur localement, il ouvre un tunnel `mcp-remote` vers
  `https://scrapegraph-mcp--scrapegraphai.run.tools`, qui répond
  `401 invalid_token / Missing Authorization header` : il attend un jeton OAuth
  Smithery, pas la clé `SGAI-…` passée dans `--config`.

Le lancement direct par `uvx` évite l'intermédiaire, et sert la version 3.4.4 du serveur
alors que le paquet PyPI `scrapegraph-mcp` est resté en 1.0.1.

### Figer la version

Le dépôt amont ne publie pas de tags. Pour un comportement reproductible, épingler le
commit dans `.mcp.json` :

```
"git+https://github.com/ScrapeGraphAI/scrapegraph-mcp@8372895aa6eaf72b1930ce634d3c1d74b412572e"
```

(commit vérifié en 3.4.4). Sans épinglage, `uvx` suit `main`.

## Cadre légal

- Le scraping massif de LinkedIn **viole leurs conditions d'utilisation** et expose à
  la suspension du compte.
- Toute collecte de données personnelles (nom, email, téléphone) relève du **RGPD** :
  base légale, information des personnes, droit d'opposition, durée de conservation.
  L'intérêt légitime en prospection B2B se défend, mais il faut pouvoir documenter
  la source et purger sur demande.
- Rester raisonnable sur les volumes et respecter les `robots.txt`.

## Retirer le serveur

Supprimer le bloc `scrapegraph` de `.mcp.json` (ou le fichier entier) et redémarrer
Claude Code.
