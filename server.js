/**
 * SONGO ONLINE — Serveur AJAX (Node.js + Express)
 * ================================================
 * Lance avec : node server.js
 * Accès : http://localhost:3000
 *
 * Architecture :
 *   - Pas de WebSocket : on utilise du AJAX (XMLHttpRequest / fetch)
 *     avec "long polling" léger (le client interroge le serveur toutes les secondes)
 *   - Chaque partie est identifiée par un code à 6 lettres
 *   - 2 joueurs rejoignent la même partie via le code
 *   - Le serveur stocke l'état en mémoire (Map)
 *
 * Endpoints :
 *   POST /api/create              → Crée une partie, retourne { gameId, playerRole:'NORD' }
 *   POST /api/join/:gameId        → Rejoint, retourne { gameId, playerRole:'SUD' }
 *   GET  /api/state/:gameId       → État complet de la partie (polling)
 *   POST /api/move/:gameId        → Joue un coup { playerRole, cellIndex }
 *   GET  /api/ping                → Health check
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Stockage en mémoire ──────────────────────────────────────
const games = new Map();  // gameId → GameState

// ── Helpers ─────────────────────────────────────────────────
function randomId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createGameState() {
  return {
    board:         { NORD: Array(7).fill(5), SUD: Array(7).fill(5) },
    scores:        { NORD: 0, SUD: 0 },
    currentPlayer: 'SUD',
    gameOver:      false,
    winner:        null,
    endReason:     null,
    lastMove:      null,
    history:       [],
    players:       { NORD: null, SUD: null },   // sessionId des joueurs
    createdAt:     Date.now(),
    updatedAt:     Date.now(),
  };
}

// ── Logique Songo (identique au client, côté serveur) ────────

function buildPath(startPlayer) {
  const path = [];
  if (startPlayer === 'SUD') {
    for (let i = 6; i >= 0; i--) path.push({ player: 'SUD',  index: i });
    for (let i = 0; i <= 6; i++) path.push({ player: 'NORD', index: i });
  } else {
    for (let i = 6; i >= 0; i--) path.push({ player: 'NORD', index: i });
    for (let i = 0; i <= 6; i++) path.push({ player: 'SUD',  index: i });
  }
  return path;
}

function applyMove(state, playerRole, cellIndex) {
  if (state.gameOver)                    return { ok: false, error: 'Partie terminée.' };
  if (state.currentPlayer !== playerRole) return { ok: false, error: 'Ce n\'est pas votre tour.' };

  const opponent = playerRole === 'NORD' ? 'SUD' : 'NORD';
  let seeds = state.board[playerRole][cellIndex];
  if (seeds === 0) return { ok: false, error: 'Cette case est vide.' };

  // Solidarité : si camp adverse vide, doit envoyer ≥7 (ou maximum)
  const opponentEmpty = state.board[opponent].every(s => s === 0);
  if (opponentEmpty) {
    const wouldSend = countToOpponent(state, playerRole, cellIndex, seeds);
    const maxPoss   = maxToOpponent(state, playerRole);
    if (wouldSend < 7 && wouldSend < maxPoss) {
      return { ok: false, error: 'Solidarité : envoyez ≥7 graines chez l\'adversaire (ou le max possible).' };
    }
  }

  // Distribution
  const path  = buildPath(playerRole);
  const start = path.findIndex(p => p.player === playerRole && p.index === cellIndex);
  const skipStart = seeds >= 14;
  let cur = start;
  const positions = [];

  for (let s = 0; s < seeds; s++) {
    cur = (cur + 1) % path.length;
    const pos = path[cur];
    if (skipStart && pos.player === playerRole && pos.index === cellIndex) {
      cur = (cur + 1) % path.length;
      positions.push(path[cur]);
    } else {
      positions.push(pos);
    }
  }

  let tempBoard = { NORD: [...state.board.NORD], SUD: [...state.board.SUD] };
  tempBoard[playerRole][cellIndex] = 0;
  positions.forEach(p => { tempBoard[p.player][p.index]++; });

  // Interdit : vider complètement le camp adverse
  const wouldEmpty = tempBoard[opponent].every(s => s === 0);

  // Prises
  let captured = 0;
  const lastPos = positions[positions.length - 1];
  if (!wouldEmpty && lastPos.player === opponent) {
    const isCase1   = lastPos.index === 0;
    const fullTour  = seeds >= 14;
    if (isCase1 && fullTour) {
      captured = 1;
      tempBoard[opponent][0]--;
    } else if (!isCase1) {
      let checkPos = lastPos;
      let chain = true;
      while (chain && checkPos.player === opponent && checkPos.index !== 0) {
        const cnt = tempBoard[checkPos.player][checkPos.index];
        if (cnt >= 2 && cnt <= 4) {
          captured += cnt;
          tempBoard[checkPos.player][checkPos.index] = 0;
          const prev = checkPos.index - 1;
          if (prev > 0) {
            checkPos = { player: opponent, index: prev };
          } else if (prev === 0) {
            const cnt0 = tempBoard[opponent][0];
            if (cnt0 >= 2 && cnt0 <= 4) {
              captured += cnt0;
              tempBoard[opponent][0] = 0;
            }
            chain = false;
          } else { chain = false; }
        } else { chain = false; }
      }
    }
  }

  // Règle case 7
  let case7Penalty = 0;
  if (cellIndex === 6) {
    const sentOpp = positions.filter(p => p.player === opponent).length;
    if (sentOpp === 1 || sentOpp === 2) {
      case7Penalty = sentOpp;
      captured = Math.max(0, captured - sentOpp);
      state.scores[opponent] += sentOpp;
      const opPositions = positions.filter(p => p.player === opponent);
      opPositions.forEach(p => { tempBoard[p.player][p.index] = Math.max(0, tempBoard[p.player][p.index] - 1); });
    }
  }

  state.board = tempBoard;
  state.scores[playerRole] += captured;

  const log = `${playerRole} : case ${cellIndex+1} (${seeds} gr.) → ${captured > 0 ? '🌾 +'+captured : 'aucune prise'}${case7Penalty ? ' ⚠️ case7 pénalité' : ''}`;
  state.history.push(log);
  state.lastMove = { player: playerRole, cell: cellIndex, seeds, captured };

  // Vérifier fin
  const total = state.board.NORD.reduce((a,b)=>a+b,0) + state.board.SUD.reduce((a,b)=>a+b,0);
  if (state.scores.NORD >= 40 || state.scores.SUD >= 40 || total < 10) {
    if (total < 10) {
      state.scores.NORD += state.board.NORD.reduce((a,b)=>a+b,0);
      state.scores.SUD  += state.board.SUD.reduce((a,b)=>a+b,0);
      state.board.NORD = Array(7).fill(0);
      state.board.SUD  = Array(7).fill(0);
    }
    state.gameOver  = true;
    state.endReason = total < 10 ? 'Moins de 10 graines restantes.' : 'Un joueur a atteint 40 graines.';
    state.winner    = state.scores.NORD >= 40 ? 'NORD' : (state.scores.SUD >= 40 ? 'SUD' : (state.scores.NORD > state.scores.SUD ? 'NORD' : (state.scores.SUD > state.scores.NORD ? 'SUD' : null)));
  } else {
    // Changer de joueur + solidarité
    state.currentPlayer = opponent;
    if (state.board[opponent].every(s => s === 0)) {
      const canReach = state.board[playerRole].some((s, i) => s > 0 && countToOpponent(state, playerRole, i, s) > 0);
      if (!canReach) {
        state.scores.NORD += state.board.NORD.reduce((a,b)=>a+b,0);
        state.scores.SUD  += state.board.SUD.reduce((a,b)=>a+b,0);
        state.board.NORD = Array(7).fill(0); state.board.SUD = Array(7).fill(0);
        state.gameOver  = true;
        state.endReason = 'Solidarité impossible.';
        state.winner    = state.scores.NORD > state.scores.SUD ? 'NORD' : (state.scores.SUD > state.scores.NORD ? 'SUD' : null);
      }
    }
  }

  state.updatedAt = Date.now();
  return { ok: true };
}

function countToOpponent(state, player, idx, seeds) {
  const opponent = player === 'NORD' ? 'SUD' : 'NORD';
  const path = buildPath(player);
  const start = path.findIndex(p => p.player === player && p.index === idx);
  const skip = seeds >= 14;
  let cur = start;
  let count = 0;
  for (let s = 0; s < seeds; s++) {
    cur = (cur + 1) % path.length;
    const pos = path[cur];
    if (skip && pos.player === player && pos.index === idx) { cur = (cur+1)%path.length; }
    if (path[cur].player === opponent) count++;
  }
  return count;
}

function maxToOpponent(state, player) {
  let max = 0;
  for (let i = 0; i < 7; i++) {
    if (state.board[player][i] > 0) {
      const c = countToOpponent(state, player, i, state.board[player][i]);
      if (c > max) max = c;
    }
  }
  return max;
}

// ── Nettoyage des parties inactives (> 2h) ───────────────────
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, g] of games.entries()) {
    if (g.updatedAt < cutoff) games.delete(id);
  }
}, 10 * 60 * 1000);

// ── Routes API ───────────────────────────────────────────────

app.get('/api/ping', (_, res) => res.json({ ok: true, games: games.size }));

// Créer une partie
app.post('/api/create', (req, res) => {
  let gameId;
  do { gameId = randomId(); } while (games.has(gameId));
  const state = createGameState();
  const sessionId = randomId(12);
  state.players.NORD = sessionId;
  games.set(gameId, state);
  res.json({ ok: true, gameId, playerRole: 'NORD', sessionId });
});

// Rejoindre une partie
app.post('/api/join/:gameId', (req, res) => {
  const state = games.get(req.params.gameId.toUpperCase());
  if (!state)                  return res.status(404).json({ ok: false, error: 'Partie introuvable.' });
  if (state.players.SUD)       return res.status(400).json({ ok: false, error: 'Partie déjà complète.' });
  const sessionId = randomId(12);
  state.players.SUD = sessionId;
  state.updatedAt = Date.now();
  res.json({ ok: true, gameId: req.params.gameId.toUpperCase(), playerRole: 'SUD', sessionId });
});

// État de la partie (polling)
app.get('/api/state/:gameId', (req, res) => {
  const state = games.get(req.params.gameId.toUpperCase());
  if (!state) return res.status(404).json({ ok: false, error: 'Partie introuvable.' });
  // On expose l'état sans les sessionIds
  res.json({
    ok: true,
    board:         state.board,
    scores:        state.scores,
    currentPlayer: state.currentPlayer,
    gameOver:      state.gameOver,
    winner:        state.winner,
    endReason:     state.endReason,
    lastMove:      state.lastMove,
    history:       state.history,
    playersReady:  { NORD: !!state.players.NORD, SUD: !!state.players.SUD },
    updatedAt:     state.updatedAt,
  });
});

// Jouer un coup
app.post('/api/move/:gameId', (req, res) => {
  const state = games.get(req.params.gameId.toUpperCase());
  if (!state) return res.status(404).json({ ok: false, error: 'Partie introuvable.' });

  const { playerRole, cellIndex, sessionId } = req.body;
  // Vérifier l'identité
  if (state.players[playerRole] !== sessionId)
    return res.status(403).json({ ok: false, error: 'Session invalide.' });

  const result = applyMove(state, playerRole, cellIndex);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, state: {
    board: state.board, scores: state.scores,
    currentPlayer: state.currentPlayer, gameOver: state.gameOver,
    winner: state.winner, endReason: state.endReason, lastMove: state.lastMove
  }});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Serveur Songo en ligne → http://localhost:${PORT}`));
