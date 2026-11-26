// Magasin de données partagées entre les postes de l'équipe.
//
// Les prospects et les commandes en attente n'existent pas dans EasyBeer : ils
// nous appartiennent. Ce module les range côté serveur pour que tout le monde
// voie la même chose, tout en restant utilisable si la base n'est pas encore
// configurée — dans ce cas on retombe sur le stockage du navigateur, comme
// avant, et l'application fonctionne exactement pareil pour un poste seul.
//
// Écriture immédiate en local puis envoi au serveur : l'interface ne fige
// jamais en attendant le réseau, et une coupure ne fait pas perdre la saisie.

function creerMagasin(espace, { surChangement = () => {}, reprendreUneFois = null } = {}) {
  const cleLocale = `lgdm-${espace}`;
  let items = lireLocal();
  let partage = null;          // null = on ne sait pas encore, true/false ensuite
  let enAttente = new Map();   // enregistrements pas encore acceptés par le serveur

  // Reprise exceptionnelle, une fois par poste, de tout le contenu local : pour
  // un espace dont le partage a été en panne, chaque poste renvoie ce qu'il a
  // gardé. Le serveur n'écrase rien de ce qu'il a déjà.
  const cleReprise = reprendreUneFois ? `lgdm-${espace}-reprise-${reprendreUneFois}` : null;
  const repriseFaite = () => { try { return localStorage.getItem(cleReprise) === '1'; } catch { return true; } };
  const marquerReprise = () => { try { localStorage.setItem(cleReprise, '1'); } catch {} };

  function lireLocal() {
    try { return JSON.parse(localStorage.getItem(cleLocale)) ?? []; } catch { return []; }
  }
  function ecrireLocal() {
    try { localStorage.setItem(cleLocale, JSON.stringify(items)); } catch {}
  }

  async function api(chemin, options) {
    const r = await fetch(`/api/donnees/${espace}${chemin}`, options);
    if (r.status === 503) { partage = false; return null; }   // base non configurée
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  }

  // Rejoue les écritures qu'une coupure réseau avait laissées en plan
  async function vider() {
    for (const [id, item] of [...enAttente]) {
      try {
        await api(item === null ? `/${id}` : `/${id}`, item === null
          ? { method: 'DELETE' }
          : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
        enAttente.delete(id);
      } catch { return; }   // toujours coupé : on réessaiera au prochain cycle
    }
  }

  /** Charge l'état partagé ; reprend le contenu local la première fois. */
  async function charger() {
    let data;
    try { data = await api(''); } catch { return items; }   // hors ligne : on garde le local
    if (!data) return items;                                // base non configurée
    // Réponse inattendue (proxy, page d'erreur, ancienne version) : on ne
    // touche à rien plutôt que de casser la page qui nous appelle.
    if (!Array.isArray(data.items)) return items;
    partage = true;

    // Premier chargement partagé d'un poste qui avait déjà des données à lui,
    // ou reprise unique demandée pour cet espace
    const repriseUnique = !!cleReprise && !repriseFaite();
    if (items.length && (!data.items.length || repriseUnique)) {
      try {
        for (let i = 0; i < items.length; i += 500) {   // le serveur prend 500 enregistrements par envoi
          await api('/reprise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items.slice(i, i + 500)),
          });
        }
        data = await api('') ?? data;
        if (repriseUnique) marquerReprise();
      } catch {
        return items;   // envoi raté : la copie locale est gardée telle quelle, on réessaiera
      }
    } else if (repriseUnique) {
      marquerReprise();  // rien à reprendre sur ce poste
    }
    await vider();
    items = data.items ?? [];
    ecrireLocal();
    surChangement();
    return items;
  }

  return {
    get espacePartage() { return partage; },
    tout: () => items,

    async enregistrer(item) {
      const i = items.findIndex(x => String(x.id) === String(item.id));
      if (i >= 0) items[i] = item; else items.unshift(item);
      ecrireLocal();
      surChangement();
      if (partage === false) return;
      try { await api(`/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }); }
      catch { enAttente.set(String(item.id), item); }
    },

    async supprimer(id) {
      items = items.filter(x => String(x.id) !== String(id));
      ecrireLocal();
      surChangement();
      if (partage === false) return;
      try { await api(`/${id}`, { method: 'DELETE' }); }
      catch { enAttente.set(String(id), null); }
    },

    charger,

    /** Rafraîchit régulièrement pour voir le travail des collègues. */
    suivre(intervalleMs = 60_000) {
      const rafraichir = () => { if (partage !== false && !document.hidden) charger(); };
      document.addEventListener('visibilitychange', rafraichir);
      window.addEventListener('online', rafraichir);
      setInterval(rafraichir, intervalleMs);
    },
  };
}

window.creerMagasin = creerMagasin;
