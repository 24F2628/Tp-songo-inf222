# 🎮 SONGO — Jeu Ekang du Cameroun

Deux versions jouables du Songo, d'après les règles de Serge MBARGA OWONA.

---

## Version 1 — Deux joueurs, même écran

**Fichier :** `songo_local.html`

Ouvre simplement le fichier dans un navigateur. Aucune installation requise.
Les deux joueurs jouent en alternance sur le même appareil.

---

## Version 2 — Joueurs distants (AJAX)

**Fichiers :** `server.js` + `songo_online.html`

### Prérequis
- Node.js installé (https://nodejs.org)

### Installation
```bash
npm install
```

### Lancement du serveur
```bash
node server.js
# → http://localhost:3000
```

### Comment jouer à distance

**Joueur 1 (NORD) :**
1. Lance `node server.js` sur sa machine
2. Ouvre `songo_online.html` dans son navigateur
3. Clique **Créer la partie** → reçoit un code à 6 lettres (ex: `AB3Z7K`)
4. Envoie ce code à l'adversaire (WhatsApp, SMS, etc.)

**Joueur 2 (SUD) :**
1. Ouvre `songo_online.html`
2. Entre l'URL du serveur du Joueur 1 (ex: `http://192.168.1.5:3000`)
3. Colle le code reçu → clique **Rejoindre**

> ⚠️ Pour jouer sur Internet (pas seulement réseau local), héberge `server.js`
> sur un service comme Railway, Render, ou Glitch (gratuit).

---

## Architecture AJAX (Version 2)

```
Joueur A (navigateur)          Serveur Node.js           Joueur B (navigateur)
       │                              │                           │
       │── POST /api/create ─────────>│                           │
       │<─ { gameId, sessionId } ─────│                           │
       │                              │                           │
       │── GET /api/state (poll) ────>│<── POST /api/join ────────│
       │<─ { playersReady... } ───────│                           │
       │                              │                           │
       │  [Jeu en cours]              │  [Jeu en cours]           │
       │── POST /api/move ───────────>│                           │
       │<─ { ok, state } ────────────│                           │
       │                              │                           │
       │                              │<── GET /api/state (poll) ─│
       │                              │─── { board, scores... } ──>│
```

**Polling :** chaque client interroge `/api/state` toutes les **secondes** via `XMLHttpRequest`.
Quand l'état change (`updatedAt`), le tablier se met à jour automatiquement.

---

## Règles implémentées

- ✅ Distribution droite→gauche (propre camp) puis gauche→droite (camp adverse)
- ✅ Saut de la case de départ si ≥14 graines
- ✅ Récolte (2–4 graines en case adverse, hors case 1)
- ✅ Prise en chaîne
- ✅ Cas spécial case n°1 adverse après tour complet (≥14 graines → 1 graine)
- ✅ Solidarité (camp adverse vide → ≥7 graines ou maximum)
- ✅ Interdit case 7 (1 ou 2 graines chez l'adversaire)
- ✅ Interdit vider complètement le camp adverse
- ✅ Fin de partie (≥40 graines, <10 graines, solidarité impossible)
