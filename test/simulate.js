// Simule une partie complète avec 3 joueurs (lance : npm test)
process.env.PORT = process.env.PORT || '3999';
const { server } = require('../server/index');
const { io: Client } = require('socket.io-client');
const assert = require('assert');

const URL = `http://localhost:${process.env.PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const s = Client(URL, { transports: ['websocket'], forceNew: true });
  s.state = null;
  s.on('state', (st) => (s.state = st));
  s.name = name;
  return s;
}
const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
async function until(fn, label, ms = 8000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('Timeout: ' + label);
    await wait(20);
  }
}

(async () => {
  const a = client('Enzo');
  const b = client('Lucas');
  const c = client('Inès');
  const created = await call(a, 'createRoom', { name: 'Enzo', avatar: '🐸' });
  assert(created.ok, 'création');
  const code = created.code;
  assert((await call(b, 'joinRoom', { code, name: 'Lucas' })).ok);
  assert((await call(c, 'joinRoom', { code, name: 'Inès' })).ok);
  await until(() => a.state && a.state.players.length === 3, 'lobby à 3');

  a.emit('updateSettings', { rounds: 1, maxQuestions: 4, answerTime: 5, speedBonus: true });
  await until(() => a.state.settings.rounds === 1, 'réglages');
  assert((await call(a, 'start')).ok, 'start');

  const all = [a, b, c];
  const byId = (id) => all.find((s) => s.state.you === id);
  let turns = 0;
  let jokerTested = false;
  let contestTested = false;

  while (true) {
    await until(() => ['turnIntro', 'answering', 'turnEnd', 'gameEnd'].includes(a.state.phase), 'phase');
    const ph = a.state.phase;
    if (ph === 'gameEnd') break;
    if (ph === 'turnIntro') {
      turns++;
      byId(a.state.mastergoonId).emit('advance');
      await until(() => a.state.phase !== 'turnIntro', 'fin intro');
      continue;
    }
    if (ph === 'turnEnd') {
      byId(a.state.mastergoonId) && byId(a.state.mastergoonId).emit('advance');
      await until(() => a.state.phase !== 'turnEnd', 'fin turnEnd');
      continue;
    }
    // answering
    const st = a.state;
    const mg = byId(st.mastergoonId);
    mg.emit('answer', { text: 'Jaune' });
    const others = all.filter((s) => s !== mg);
    for (const s of others) {
      await until(() => s.state.phase !== 'answering' || s.state.isParticipant !== undefined, 'vue');
      if (s.state.phase !== 'answering') break;
      if (s.state.isParticipant) {
        // le premier non-MG dit la même chose → éliminé
        const same = s === others[0] && st.qIndex === 0;
        s.emit('answer', { text: same ? 'jaune ' : 'Bleu ' + s.name });
      } else if (s.state.canJoker && !jokerTested) {
        jokerTested = true;
        s.emit('answer', { text: 'JAUNE', joker: true });
      } else if (s.state.canJoker) {
        s.emit('passJoker');
      }
    }
    await until(() => ['validating', 'reveal'].includes(a.state.phase), 'validation');
    if (a.state.phase === 'validating') {
      await until(() => mg.state.entries, 'entries mg');
      mg.emit('confirmValidation');
    }
    await until(() => a.state.phase === 'reveal', 'reveal');
    const revive = a.state.entries.find((e) => e.joker);
    if (revive) assert.strictEqual(revive.verdict, 'revive', 'joker JAUNE = Jaune doit réussir');
    if (!contestTested) {
      const target = a.state.entries.find((e) => !e.locked);
      const voter = others.find((s) => s.state.you !== target.pid);
      if (voter) {
        contestTested = true;
        voter.emit('contest', target.pid);
        await until(() => a.state.entries.find((e) => e.pid === target.pid).contests === 1, 'contest');
        voter.emit('contest', target.pid); // annule
        await until(() => a.state.entries.find((e) => e.pid === target.pid).contests === 0, 'contest annulé');
      }
    }
    mg.emit('advance');
    await until(() => a.state.phase !== 'reveal', 'après reveal');
  }

  const end = a.state;
  assert.strictEqual(turns, 3, '3 tours (1 par joueur) pour 1 manche');
  assert(end.awards && end.history.length === 3, 'récap + awards');
  assert(jokerTested, 'joker testé');
  console.log('Classement :', end.players.map((p) => `${p.name}=${p.score}`).join(', '));
  console.log('Awards :', end.awards.map((x) => `${x.title}→${x.name}`).join(' | '));
  console.log('✅ Partie simulée avec succès');

  a.emit('backToLobby');
  await until(() => a.state.phase === 'lobby', 'retour lobby');
  all.forEach((s) => s.close());
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
