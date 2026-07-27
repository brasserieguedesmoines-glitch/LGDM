# ScrapeGraph AI — serveur MCP

Le fichier `.mcp.json` à la racine déclare le serveur MCP **scrapegraph**
([ScrapeGraphAI/scrapegraph-mcp](https://github.com/ScrapeGraphAI/scrapegraph-mcp)),
lancé via le CLI Smithery. Une fois la clé API en place, Claude Code peut extraire
des données structurées depuis des pages web en langage naturel.

## 1. Récupérer une clé API

1. Créer un compte sur [scrapegraphai.com](https://scrapegraphai.com) (plan gratuit disponible).
2. Copier la clé dans le dashboard — format `SGAI-xxxxxxxx`.

## 2. Fournir la clé à Claude Code

La clé **n'est jamais écrite dans `.mcp.json`** : le fichier référence la variable
`${SCRAPEGRAPH_API_KEY}`, que Claude Code résout au démarrage du serveur.

Deux façons de la définir, au choix.

### Option A — variable d'environnement du shell (recommandée)

```bash
# à ajouter dans ~/.zshrc, ~/.bashrc, etc.
export SCRAPEGRAPH_API_KEY="SGAI-xxxxxxxx"
```

Puis ouvrir un nouveau terminal avant de relancer Claude Code.

### Option B — `.claude/settings.local.json`

Ce fichier est ignoré par git (voir `.gitignore`), il ne partira donc pas sur GitHub :

```json
{
  "env": {
    "SCRAPEGRAPH_API_KEY": "SGAI-xxxxxxxx"
  }
}
```

> ⚠️ Le `.env` du projet **ne convient pas** : il est lu par `dotenv` au démarrage
> de `server.js`, pas par Claude Code. Les serveurs MCP n'y ont pas accès.

## 3. Activer le serveur

Redémarrer Claude Code dans le dossier du projet. À la première ouverture, Claude Code
demande d'approuver les serveurs MCP déclarés dans `.mcp.json` — répondre oui.

Vérifier ensuite avec :

```
/mcp
```

`scrapegraph` doit apparaître avec le statut *connected*. Si la connexion échoue,
la cause la plus fréquente est une variable `SCRAPEGRAPH_API_KEY` absente du shell
qui a lancé Claude Code.

## 4. Utilisation

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
