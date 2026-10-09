// Logique d'une salle de Mastergoon.
// Vocabulaire :
//   - question : une question posée (+1 point par survivant)
//   - tour     : un Mastergoon enchaîne les questions jusqu'à ce que tout le monde soit éliminé
//   - manche   : chaque joueur a été Mastergoon une fois

const crypto = require('crypto');
const { CATEGORIES, QUESTIONS } = require('./questions');

const AVATARS = ['🐸', '🦊', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🦖', '🐝', '🦉', '🐨', '🐲', '🦀', '🐷', '👽', '🤖', '👻', '🍄', '🌵'];
const COLORS = ['#c8ff3e', '#ff3e8a', '#3ee0ff', '#ffb23e', '#b48cff', '#3effa6', '#ff6e3e', '#ffe53e', '#ff8ce6', '#7d9bff', '#ff4d4d', '#45ffe0'];
const REACTIONS = ['😂', '😱', '🔥', '💀', '👏', '🤡', '😭', '🫡'];
const MAX_PLAYERS = 12;
const MAX_ANSWER = 40;

const TURN_INTRO_MS = 4000;
const JUDGING_TIMEOUT_MS = 120000; // sécurité si le Mastergoon ne clique jamais sur « suivant »
const TURN_END_TIMEOUT_MS = 20000;

const DEFAULT_SETTINGS = {
  categories: CATEGORIES.filter((c) => c.id !== 'custom').map((c) => c.id),
  answerTime: 20,
  rounds: 3,
  maxQuestions: 10,
  mode: 'different', // 'different' | 'same'
  playersMustDiffer: false,
  speedBonus: false,
  showChoices: true,
  jokerEnabled: true, // joker illimité pour les joueurs éliminés
  customQuestions: [],
};

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(le|la|les|l|un|une|des|du|de|d) /, '')
    .replace(/s$/, '');
}

function clean(s, max = MAX_ANSWER) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function newStats() {
  return { survived: 0, eliminatedFirst: 0, revives: 0, jokerTries: 0, answerTimes: [], mgEliminations: 0, turnsAsMg: 0, timeouts: 0 };
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange; // appelé pour diffuser l'état
    this.players = [];
    this.screens = new Set(); // sockets du mode TV
    this.hostId = null;
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.phase = 'lobby';
    this.timer = null;
    this.lastActivity = Date.now();
    this.colorCursor = 0;
    this.resetGame();
  }

  // ---------- Joueurs ----------

  resetGame() {
    this.clearTimer();
    this.manche = 0;
    this.mancheOrder = [];
    this.turnIndex = -1;
    this.mastergoonId = null;
    this.qIndex = 0;
    this.question = null;
    this.resetQuestionState();
    this.history = [];
    this.turnLog = null;
    this.used = new Set();
    this.awards = null;
    for (const p of this.players) {
      p.score = 0;
      p.alive = true;
      p.jokerUsed = false;
      p.stats = newStats();
    }
  }

  resetQuestionState() {
    this.mgAnswer = null;
    this.answers = {};
    this.jokerAnswers = {};
    this.jokerPass = new Set();
    this.decisions = {};
    this.contests = {};
    this.questionStart = 0;
    this.deadline = null;
    this.mgTimeout = false;
  }

  get(id) {
    return this.players.find((p) => p.id === id);
  }

  active() {
    return this.players.filter((p) => !p.spectator && !p.left);
  }

  connectedCount() {
    return this.players.filter((p) => p.connected && !p.left).length + this.screens.size;
  }

  addPlayer(name, avatar) {
    const present = this.players.filter((p) => !p.left);
    if (present.length >= MAX_PLAYERS) return { error: 'La salle est pleine (12 joueurs max).' };
    let base = clean(name, 16) || 'Goon';
    let finalName = base;
    let n = 2;
    while (present.some((p) => p.name.toLowerCase() === finalName.toLowerCase())) finalName = `${base} ${n++}`;
    const used = new Set(present.map((p) => p.color));
    let color = COLORS.find((c) => !used.has(c)) || COLORS[this.colorCursor++ % COLORS.length];
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: finalName,
      avatar: AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)],
      color,
      socketId: null,
      connected: false,
      spectator: this.phase !== 'lobby',
      left: false,
      joinedAt: Date.now(),
      score: 0,
      alive: true,
      jokerUsed: false,
      stats: newStats(),
      lastReaction: 0,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return { player: p };
  }

  removePlayer(id) {
    const p = this.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== id);
    } else {
      p.left = true;
      p.connected = false;
      p.alive = false;
    }
    if (this.hostId === id) this.reassignHost();
    if (this.phase !== 'lobby' && this.phase !== 'gameEnd') {
      if (this.active().length < 2) return this.endGame();
      if (id === this.mastergoonId) return this.endTurn();
      this.checkAllIn();
    }
    this.emit();
  }

  reassignHost() {
    const next = this.players.find((p) => !p.left && p.connected) || this.players.find((p) => !p.left);
    this.hostId = next ? next.id : null;
  }

  setConnected(id, socketId, connected) {
    const p = this.get(id);
    if (!p) return;
    p.connected = connected;
    p.socketId = connected ? socketId : null;
    if (!connected && this.hostId === id) {
      // l'hôte ne change que s'il reste déconnecté un moment
      setTimeout(() => {
        const still = this.get(id);
        if (still && !still.connected && this.hostId === id) {
          this.reassignHost();
          this.emit();
        }
      }, 15000);
    }
    if (!connected && this.phase === 'answering') this.checkAllIn();
    this.touch();
    this.emit();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  emit() {
    this.onChange(this);
  }

  // ---------- Paramètres ----------

  updateSettings(patch) {
    if (this.phase !== 'lobby' || !patch || typeof patch !== 'object') return;
    const s = this.settings;
    if (Array.isArray(patch.categories)) {
      const valid = CATEGORIES.map((c) => c.id);
      s.categories = patch.categories.filter((c) => valid.includes(c));
    }
    if (patch.answerTime !== undefined) s.answerTime = Math.min(120, Math.max(5, parseInt(patch.answerTime, 10) || 20));
    if (patch.rounds !== undefined) s.rounds = Math.min(10, Math.max(1, parseInt(patch.rounds, 10) || 3));
    if (patch.maxQuestions !== undefined) s.maxQuestions = Math.min(20, Math.max(3, parseInt(patch.maxQuestions, 10) || 10));
    if (patch.mode !== undefined) s.mode = patch.mode === 'same' ? 'same' : 'different';
    for (const k of ['playersMustDiffer', 'speedBonus', 'showChoices', 'jokerEnabled']) {
      if (patch[k] !== undefined) s[k] = !!patch[k];
    }
    if (Array.isArray(patch.customQuestions)) {
      s.customQuestions = patch.customQuestions
        .slice(0, 200)
        .map((q, i) => {
          const text = clean(q && q.text, 120);
          if (!text) return null;
          const level = Math.min(5, Math.max(1, parseInt(q.level, 10) || 3));
          let choices = Array.isArray(q.choices) ? q.choices.map((c) => clean(c, 40)).filter(Boolean).slice(0, 20) : null;
          if (choices && !choices.length) choices = null;
          return { id: `custom-${i}-${normalize(text).slice(0, 20)}`, cat: 'custom', level, text, choices };
        })
        .filter(Boolean);
    }
    this.touch();
    this.emit();
  }

  // ---------- Déroulement ----------

  setTimer(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  canStart() {
    return this.active().filter((p) => p.connected).length >= 2;
  }

  start() {
    if (this.phase !== 'lobby' || !this.canStart()) return false;
    if (!this.questionPool().length) return false;
    this.resetGame();
    this.manche = 1;
    this.mancheOrder = this.active().map((p) => p.id);
    this.turnIndex = -1;
    this.nextTurn();
    return true;
  }

  isEligibleMg(id) {
    const p = this.get(id);
    return p && !p.left && !p.spectator && p.connected;
  }

  nextTurn() {
    this.clearTimer();
    this.turnIndex++;
    while (this.turnIndex < this.mancheOrder.length && !this.isEligibleMg(this.mancheOrder[this.turnIndex])) this.turnIndex++;
    if (this.turnIndex >= this.mancheOrder.length) {
      this.manche++;
      if (this.manche > this.settings.rounds) return this.endGame();
      // les spectateurs rejoignent la partie à la nouvelle manche
      for (const p of this.players) {
        if (p.spectator && !p.left) {
          p.spectator = false;
          p.score = 0;
          p.stats = newStats();
        }
      }
      this.mancheOrder = this.active().map((p) => p.id);
      this.turnIndex = 0;
      while (this.turnIndex < this.mancheOrder.length && !this.isEligibleMg(this.mancheOrder[this.turnIndex])) this.turnIndex++;
      if (this.turnIndex >= this.mancheOrder.length) return this.endGame();
    }
    if (this.active().length < 2) return this.endGame();

    this.mastergoonId = this.mancheOrder[this.turnIndex];
    const mg = this.get(this.mastergoonId);
    mg.stats.turnsAsMg++;
    this.qIndex = 0;
    for (const p of this.active()) {
      p.alive = true;
    }
    this.turnLog = { manche: this.manche, mastergoonId: mg.id, mgName: mg.name, mgAvatar: mg.avatar, questions: [], firstOutDone: false };
    this.history.push(this.turnLog);
    this.question = null;
    this.resetQuestionState();
    this.phase = 'turnIntro';
    this.setTimer(TURN_INTRO_MS, () => this.nextQuestion());
    this.emit();
  }

  participants() {
    // joueurs en vie (hors Mastergoon)
    return this.active().filter((p) => p.id !== this.mastergoonId && p.alive);
  }

  jokerEligible() {
    // joker illimité : tout joueur éliminé peut le tenter à chaque question
    if (!this.settings.jokerEnabled) return [];
    return this.active().filter((p) => p.id !== this.mastergoonId && !p.alive);
  }

  questionPool() {
    const cats = this.settings.categories;
    const pool = QUESTIONS.filter((q) => cats.includes(q.cat));
    if (cats.includes('custom')) pool.push(...this.settings.customQuestions);
    return pool;
  }

  pickQuestion() {
    const pool = this.questionPool();
    if (!pool.length) return null;
    const target = Math.min(5, 1 + Math.floor((this.qIndex * 5) / this.settings.maxQuestions));
    let fresh = pool.filter((q) => !this.used.has(q.id));
    if (!fresh.length) {
      this.used.clear();
      fresh = pool;
    }
    for (let d = 0; d <= 4; d++) {
      const cands = fresh.filter((q) => Math.abs(q.level - target) === d);
      // à distance égale, on préfère monter en difficulté
      const up = cands.filter((q) => q.level >= target);
      const pickFrom = up.length ? up : cands;
      if (pickFrom.length) {
        const q = pickFrom[Math.floor(Math.random() * pickFrom.length)];
        this.used.add(q.id);
        return q;
      }
    }
    return null;
  }

  nextQuestion() {
    this.clearTimer();
    if (!this.isEligibleMg(this.mastergoonId)) return this.endTurn();
    if (this.qIndex >= this.settings.maxQuestions) return this.endTurn();
    if (!this.participants().length) return this.endTurn();
    const q = this.pickQuestion();
    if (!q) return this.endTurn();
    this.question = q;
    this.resetQuestionState();
    this.questionStart = Date.now();
    this.deadline = this.questionStart + this.settings.answerTime * 1000;
    this.phase = 'answering';
    this.setTimer(this.settings.answerTime * 1000 + 400, () => this.closeAnswers());
    this.emit();
  }

  submitAnswer(pid, text, useJoker) {
    if (this.phase !== 'answering') return;
    const t = clean(text);
    if (!t) return;
    const at = Date.now() - this.questionStart;
    if (pid === this.mastergoonId) {
      this.mgAnswer = t;
    } else if (this.participants().some((p) => p.id === pid)) {
      this.answers[pid] = { text: t, at };
    } else if (useJoker) {
      const p = this.get(pid);
      const canJoker = this.jokerEligible().some((x) => x.id === pid) || this.jokerAnswers[pid];
      if (!p || !canJoker) return;
      if (!this.jokerAnswers[pid]) p.stats.jokerTries++;
      this.jokerAnswers[pid] = { text: t, at };
      this.jokerPass.delete(pid);
    } else {
      return;
    }
    this.touch();
    this.checkAllIn();
    this.emit();
  }

  passJoker(pid) {
    if (this.phase !== 'answering') return;
    if (!this.jokerEligible().some((p) => p.id === pid)) return;
    this.jokerPass.add(pid);
    this.checkAllIn();
    this.emit();
  }

  checkAllIn() {
    if (this.phase !== 'answering') return;
    const mg = this.get(this.mastergoonId);
    if (!this.mgAnswer && mg && mg.connected) return;
    const waitingAlive = this.participants().some((p) => p.connected && !this.answers[p.id]);
    if (waitingAlive) return;
    const waitingJoker = this.jokerEligible().some((p) => p.connected && !this.jokerPass.has(p.id) && !this.jokerAnswers[p.id]);
    if (waitingJoker) return;
    // petite pause pour que le dernier voie son « envoyé »
    this.setTimer(600, () => this.closeAnswers());
  }

  sameAsMg(text) {
    return normalize(text) === normalize(this.mgAnswer);
  }

  closeAnswers() {
    if (this.phase !== 'answering') return;
    this.clearTimer();
    if (!this.mgAnswer) {
      // le Mastergoon n'a pas répondu : question annulée, jokers rendus
      this.mgTimeout = true;
      for (const pid of Object.keys(this.jokerAnswers)) {
        const p = this.get(pid);
        if (p) p.jokerUsed = false;
      }
      this.phase = 'reveal';
      this.setTimer(JUDGING_TIMEOUT_MS, () => this.advance(null, true));
      this.emit();
      return;
    }
    const mode = this.settings.mode;
    this.decisions = {};
    for (const p of this.participants()) {
      const a = this.answers[p.id];
      if (!a) {
        this.decisions[p.id] = { verdict: 'out', reason: 'timeout', locked: true };
        continue;
      }
      const same = this.sameAsMg(a.text);
      if (mode === 'different') this.decisions[p.id] = same ? { verdict: 'out', reason: 'same' } : { verdict: 'survive', reason: null };
      else this.decisions[p.id] = same ? { verdict: 'survive', reason: null } : { verdict: 'out', reason: 'diff' };
    }
    if (this.settings.playersMustDiffer) {
      const groups = {};
      for (const [pid, a] of Object.entries(this.answers)) {
        const k = normalize(a.text);
        (groups[k] = groups[k] || []).push(pid);
      }
      for (const ids of Object.values(groups)) {
        if (ids.length < 2) continue;
        for (const pid of ids) {
          const d = this.decisions[pid];
          if (d && d.verdict === 'survive') this.decisions[pid] = { verdict: 'out', reason: 'dup' };
        }
      }
    }
    for (const [pid, a] of Object.entries(this.jokerAnswers)) {
      const same = this.sameAsMg(a.text);
      // le joker est l'inverse du mode : en mode « différent », il faut dire PAREIL
      const ok = mode === 'different' ? same : !same;
      this.decisions[pid] = { verdict: ok ? 'revive' : 'fail', reason: null, joker: true };
    }
    // Toutes les réponses sont affichées à tout le monde, le Mastergoon juge en direct
    this.phase = 'reveal';
    this.setTimer(JUDGING_TIMEOUT_MS, () => this.advance(null, true));
    this.emit();
  }

  isValidator(pid) {
    if (pid === this.mastergoonId) return true;
    const mg = this.get(this.mastergoonId);
    return pid === this.hostId && (!mg || !mg.connected);
  }

  canDrive(pid) {
    // qui peut faire avancer la partie (Mastergoon ou hôte)
    return pid === this.mastergoonId || pid === this.hostId;
  }

  setDecision(by, pid, verdict) {
    if (this.phase !== 'reveal' || this.mgTimeout || !this.isValidator(by)) return;
    const d = this.decisions[pid];
    if (!d || d.locked) return;
    // la décision change : les votes de contestation repartent de zéro
    delete this.contests[pid];
    if (d.joker) {
      if (!['revive', 'fail'].includes(verdict)) return;
      this.decisions[pid] = { ...d, verdict };
    } else {
      if (verdict === 'survive') this.decisions[pid] = { verdict: 'survive', reason: null };
      else if (verdict === 'invalid') this.decisions[pid] = { verdict: 'out', reason: 'invalid' };
      else if (verdict === 'dup') this.decisions[pid] = { verdict: 'out', reason: 'dup' };
      else if (verdict === 'out') this.decisions[pid] = { verdict: 'out', reason: this.settings.mode === 'different' ? 'same' : 'diff' };
    }
    this.emit();
  }

  confirmValidation(by) {
    // ancien bouton « Révéler » : équivaut maintenant à « Question suivante »
    this.advance(by);
  }

  eligibleVoters(targetId) {
    return this.active().filter((p) => p.connected && p.id !== this.mastergoonId && p.id !== targetId);
  }

  toggleContest(voterId, targetId) {
    if (this.phase !== 'reveal' || this.mgTimeout) return;
    const d = this.decisions[targetId];
    if (!d || d.locked) return;
    if (!this.eligibleVoters(targetId).some((p) => p.id === voterId)) return;
    const set = (this.contests[targetId] = this.contests[targetId] || new Set());
    if (set.has(voterId)) set.delete(voterId);
    else set.add(voterId);
    this.emit();
  }

  isFlipped(targetId) {
    const set = this.contests[targetId];
    if (!set || !set.size) return false;
    const eligible = this.eligibleVoters(targetId).length;
    return eligible > 0 && set.size > eligible / 2;
  }

  finalVerdict(pid) {
    const d = this.decisions[pid];
    if (!d) return null;
    if (!this.isFlipped(pid)) return d.verdict;
    return { survive: 'out', out: 'survive', revive: 'fail', fail: 'revive' }[d.verdict];
  }

  advance(by, auto = false) {
    if (!auto && !this.canDrive(by)) return;
    if (this.phase === 'turnIntro') return this.nextQuestion();
    if (this.phase === 'turnEnd') return this.nextTurn();
    if (this.phase !== 'reveal') return;
    this.applyResults();
    if (!this.participants().length) return this.endTurn();
    this.qIndex++;
    this.nextQuestion();
  }

  applyResults() {
    const entry = {
      text: this.question ? this.question.text : '',
      level: this.question ? this.question.level : 0,
      mgAnswer: this.mgAnswer,
      mgTimeout: this.mgTimeout,
      answers: [],
    };
    if (this.mgTimeout) {
      this.turnLog.questions.push(entry);
      return;
    }
    const mg = this.get(this.mastergoonId);
    const outNow = [];
    const survivors = [];
    for (const [pid, d] of Object.entries(this.decisions)) {
      const p = this.get(pid);
      if (!p) continue;
      const v = this.finalVerdict(pid);
      const a = d.joker ? this.jokerAnswers[pid] : this.answers[pid];
      if (a) p.stats.answerTimes.push(a.at);
      const row = { pid, name: p.name, avatar: p.avatar, text: a ? a.text : null, verdict: v, reason: d.reason, joker: !!d.joker, flipped: this.isFlipped(pid), points: 0 };
      if (d.joker) {
        if (v === 'revive' && !p.left) {
          p.alive = true;
          p.stats.revives++;
        }
      } else if (v === 'survive') {
        if (!p.left) {
          p.score += 1;
          row.points = 1;
          p.stats.survived++;
          survivors.push({ p, row, at: a ? a.at : Infinity });
        }
      } else {
        p.alive = false;
        outNow.push(p);
        if (d.reason === 'timeout') p.stats.timeouts++;
        if (mg && (d.reason === 'same' || d.reason === 'diff') && !row.flipped) mg.stats.mgEliminations++;
      }
      entry.answers.push(row);
    }
    if (this.settings.speedBonus && survivors.length) {
      survivors.sort((a, b) => a.at - b.at);
      const best = survivors[0];
      best.p.score += 1;
      best.row.points += 1;
      best.row.fastest = true;
    }
    if (outNow.length && !this.turnLog.firstOutDone) {
      this.turnLog.firstOutDone = true;
      outNow.forEach((p) => p.stats.eliminatedFirst++);
    }
    this.turnLog.questions.push(entry);
  }

  endTurn() {
    this.clearTimer();
    this.phase = 'turnEnd';
    this.question = null;
    this.resetQuestionState();
    this.setTimer(TURN_END_TIMEOUT_MS, () => this.nextTurn());
    this.emit();
  }

  skipTurn(by) {
    if (by !== this.hostId) return;
    if (['turnIntro', 'answering', 'reveal'].includes(this.phase)) this.endTurn();
  }

  endGame() {
    this.clearTimer();
    this.phase = 'gameEnd';
    this.question = null;
    this.resetQuestionState();
    this.awards = this.computeAwards();
    this.emit();
  }

  backToLobby(by) {
    if (by !== this.hostId) return;
    this.players = this.players.filter((p) => !p.left);
    for (const p of this.players) p.spectator = false;
    this.phase = 'lobby';
    this.resetGame();
    this.emit();
  }

  computeAwards() {
    const ps = this.players.filter((p) => !p.spectator && p.stats);
    const best = (fn, min = 1) => {
      let top = null;
      let val = -Infinity;
      for (const p of ps) {
        const v = fn(p);
        if (v > val) {
          val = v;
          top = p;
        }
      }
      return top && val >= min ? { id: top.id, name: top.name, avatar: top.avatar, value: val } : null;
    };
    const avg = (p) => (p.stats.answerTimes.length ? p.stats.answerTimes.reduce((a, b) => a + b, 0) / p.stats.answerTimes.length : Infinity);
    const awards = [];
    const a1 = best((p) => p.stats.mgEliminations);
    if (a1) awards.push({ emoji: '🔮', title: 'Le plus prévisible', desc: `${a1.value} joueur(s) ont dit la même chose que lui en Mastergoon`, ...a1 });
    const a2 = best((p) => p.stats.survived);
    if (a2) awards.push({ emoji: '🛡️', title: 'Survivant ultime', desc: `${a2.value} question${a2.value > 1 ? 's' : ''} survécue${a2.value > 1 ? 's' : ''}`, ...a2 });
    const a3 = best((p) => p.stats.revives);
    if (a3) awards.push({ emoji: '🃏', title: 'Roi du joker', desc: `${a3.value} retour(s) d'entre les morts`, ...a3 });
    const fast = ps.filter((p) => p.stats.answerTimes.length >= 2).sort((a, b) => avg(a) - avg(b))[0];
    if (fast) awards.push({ emoji: '⚡', title: 'Éclair', desc: `${(avg(fast) / 1000).toFixed(1)} s de réponse en moyenne`, id: fast.id, name: fast.name, avatar: fast.avatar });
    const a5 = best((p) => p.stats.eliminatedFirst);
    if (a5) awards.push({ emoji: '💀', title: 'Kamikaze', desc: `Premier éliminé ${a5.value} fois`, ...a5 });
    const a6 = best((p) => p.stats.timeouts);
    if (a6) awards.push({ emoji: '😴', title: 'Le dormeur', desc: `${a6.value} fois hors délai`, ...a6 });
    return awards;
  }

  react(pid, emoji) {
    const p = this.get(pid);
    if (!p || !REACTIONS.includes(emoji)) return false;
    const now = Date.now();
    if (now - p.lastReaction < 350) return false;
    p.lastReaction = now;
    return true;
  }

  // ---------- Vue envoyée à chaque client ----------

  view(viewerId, isTv = false) {
    const me = viewerId ? this.get(viewerId) : null;
    const phase = this.phase;
    const mgId = this.mastergoonId;
    const reveal = phase === 'reveal';
    const v = {
      code: this.code,
      phase,
      hostId: this.hostId,
      you: me ? me.id : null,
      isTv,
      settings: { ...this.settings },
      categories: CATEGORIES,
      reactions: REACTIONS,
      avatars: AVATARS,
      canStart: this.canStart(),
      poolSize: this.questionPool().length,
      manche: this.manche,
      rounds: this.settings.rounds,
      turnIndex: this.turnIndex,
      turnsInManche: this.mancheOrder.length,
      mastergoonId: mgId,
      qIndex: this.qIndex,
      maxQuestions: this.settings.maxQuestions,
      players: this.players
        .filter((p) => !p.left)
        .map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          color: p.color,
          connected: p.connected,
          spectator: p.spectator,
          score: p.score,
          alive: p.alive,
          jokerUsed: p.jokerUsed,
          answered: phase === 'answering' ? (p.id === mgId ? !!this.mgAnswer : !!this.answers[p.id] || !!this.jokerAnswers[p.id]) : false,
          jokerActive: !!this.jokerAnswers[p.id],
          jokerPassed: this.jokerPass.has(p.id),
        })),
    };
    if (this.question && ['answering', 'reveal'].includes(phase)) {
      v.question = {
        text: this.question.text,
        level: this.question.level,
        cat: this.question.cat,
        choices: this.settings.showChoices ? this.question.choices : null,
      };
    }
    if (phase === 'answering') {
      v.remainingMs = Math.max(0, this.deadline - Date.now());
      v.totalMs = this.settings.answerTime * 1000;
      if (me) {
        if (me.id === mgId) v.yourAnswer = this.mgAnswer;
        else if (this.answers[me.id]) v.yourAnswer = this.answers[me.id].text;
        else if (this.jokerAnswers[me.id]) v.yourAnswer = this.jokerAnswers[me.id].text;
        v.canJoker = this.jokerEligible().some((p) => p.id === me.id) || !!this.jokerAnswers[me.id];
        v.jokerActive = !!this.jokerAnswers[me.id];
        v.jokerPassed = this.jokerPass.has(me.id);
        v.isParticipant = this.participants().some((p) => p.id === me.id);
      }
    }
    const entries = () =>
      Object.entries(this.decisions).map(([pid, d]) => {
        const a = d.joker ? this.jokerAnswers[pid] : this.answers[pid];
        const set = this.contests[pid];
        return {
          pid,
          text: a ? a.text : null,
          at: a ? a.at : null,
          verdict: d.verdict,
          finalVerdict: this.finalVerdict(pid),
          reason: d.reason,
          joker: !!d.joker,
          locked: !!d.locked,
          contests: set ? set.size : 0,
          eligible: this.eligibleVoters(pid).length,
          youContested: !!(set && me && set.has(me.id)),
          canContest: !!(me && !d.locked && this.eligibleVoters(pid).some((p) => p.id === me.id)),
          flipped: this.isFlipped(pid),
        };
      });
    if (reveal) {
      v.validatorId = this.isValidator(mgId) ? mgId : this.hostId;
      v.youValidate = !!(me && this.isValidator(me.id));
      v.mgAnswer = this.mgAnswer;
      v.mgTimeout = this.mgTimeout;
      v.entries = entries();
      v.revealKey = `${this.turnIndex}-${this.manche}-${this.qIndex}`;
    }
    if (phase === 'turnEnd' && this.turnLog) {
      v.turnSummary = {
        mgName: this.turnLog.mgName,
        mgAvatar: this.turnLog.mgAvatar,
        questions: this.turnLog.questions.length,
        isLastTurn: this.manche >= this.settings.rounds && this.turnIndex >= this.mancheOrder.length - 1,
      };
    }
    if (phase === 'gameEnd') {
      v.awards = this.awards;
      v.history = this.history.map((t) => ({ manche: t.manche, mgName: t.mgName, mgAvatar: t.mgAvatar, questions: t.questions }));
    }
    return v;
  }
}

module.exports = { Room, normalize, REACTIONS, AVATARS };
