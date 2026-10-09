/* Mastergoon — client */
(() => {
  const AVATARS = ['🐸', '🦊', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🦖', '🐝', '🦉', '🐨', '🐲', '🦀', '🐷', '👽', '🤖', '👻', '🍄', '🌵'];
  const LEVEL_LABEL = ['', 'Très large', 'Large', 'Moyen', 'Serré', 'Très serré'];

  // ---------- Stockage local (protégé) ----------
  const store = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  const params = new URLSearchParams(location.search);
  const tvCode = (params.get('tv') || '').toUpperCase();
  const local = {
    avatar: store.get('mg_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)],
    showQr: false,
    jokerOpen: false,
    busy: false,
  };
  const drafts = {
    name: store.get('mg_name', ''),
    code: (params.get('room') || '').toUpperCase(),
    answer: '',
    cq_text: '',
    cq_level: '3',
    cq_choices: '',
  };

  let S = null; // état reçu du serveur
  let deadlineLocal = 0;
  let lastSecond = null;
  let questionKey = null;
  const revealStarts = {}; // revealKey -> heure de début de l'animation

  const $app = document.getElementById('app');
  const $connecting = document.getElementById('connecting');
  const $toast = document.getElementById('toast');
  const $reactions = document.getElementById('reactions-layer');

  // ---------- Utilitaires ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const P = (id) => (S ? S.players.find((p) => p.id === id) : null);
  const me = () => (S ? P(S.you) : null);
  const isHost = () => S && S.you && S.you === S.hostId;
  const isMg = () => S && S.you && S.you === S.mastergoonId;
  const canDrive = () => isHost() || isMg();
  const mgName = () => (P(S.mastergoonId) || {}).name || 'Le Mastergoon';
  const sameMode = () => S && S.settings.mode === 'same';
  const roomLink = () => `${location.origin}/?room=${S.code}`;

  function toast(msg, ms = 2600) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
  }

  function avatarHtml(p, size = '') {
    if (!p) return '';
    return `<span class="avatar ${size}" style="--c:${p.color}">${esc(p.avatar)}</span>`;
  }

  function levelDots(level) {
    let h = '';
    for (let i = 1; i <= 5; i++) h += `<i class="${i <= level ? 'on' : ''}"></i>`;
    return `<span class="level" title="Choix ${LEVEL_LABEL[level]}"><span class="dots">${h}</span>${LEVEL_LABEL[level]}</span>`;
  }

  function catLabel(id) {
    const c = S.categories.find((x) => x.id === id);
    return c ? `${c.emoji} ${esc(c.label)}` : '';
  }

  // ---------- Socket ----------
  const socket = io({ reconnectionDelayMax: 4000 });

  socket.on('connect', () => {
    $connecting.classList.remove('show');
    if (tvCode) {
      socket.emit('joinTv', { code: tvCode }, (r) => {
        if (r && r.error) {
          toast(r.error);
          history.replaceState(null, '', '/');
        }
      });
      return;
    }
    const sess = store.get('mg_session');
    if (sess) {
      socket.emit('resume', sess, (r) => {
        if (!r || r.error) {
          store.del('mg_session');
          S = null;
          render();
        }
      });
    }
  });
  socket.on('disconnect', () => $connecting.classList.add('show'));
  socket.io.on('reconnect_attempt', () => $connecting.classList.add('show'));

  socket.on('state', (st) => {
    const prev = S;
    S = st;
    onTransition(prev, st);
    render();
  });

  socket.on('reaction', ({ emoji, from }) => floatReaction(emoji, P(from)));
  socket.on('kicked', () => {
    store.del('mg_session');
    S = null;
    render();
    toast("Tu as été exclu de la partie par l'hôte.");
  });
  socket.on('replaced', () => {
    S = null;
    render();
    toast('Ta partie est ouverte dans un autre onglet.');
  });

  // affiche l'écran de connexion si le serveur met du temps à répondre
  setTimeout(() => {
    if (!socket.connected) $connecting.classList.add('show');
  }, 700);

  function onTransition(prev, st) {
    const pPhase = prev ? prev.phase : null;
    if (st.phase === 'answering') {
      const key = `${st.manche}-${st.turnIndex}-${st.qIndex}`;
      if (key !== questionKey) {
        questionKey = key;
        drafts.answer = '';
        local.jokerOpen = false;
        lastSecond = null;
        Sound.question();
        if (navigator.vibrate) navigator.vibrate(30);
      }
      deadlineLocal = Date.now() + st.remainingMs;
    }
    if (st.phase !== pPhase) {
      if (st.phase === 'turnIntro') Sound.mastergoon();
      if (st.phase === 'gameEnd') Sound.fanfare();
      if (st.phase === 'reveal') scheduleRevealSounds(st);
    }
  }

  function scheduleRevealSounds(st) {
    if (revealStarts[st.revealKey]) return;
    revealStarts[st.revealKey] = Date.now();
    if (st.mgTimeout) return;
    setTimeout(() => Sound.pop(), 250);
    st.entries.forEach((e, i) => {
      setTimeout(() => {
        const v = e.finalVerdict;
        if (v === 'survive') Sound.survive();
        else if (v === 'revive') Sound.joker();
        else Sound.eliminated();
        if (e.pid === st.you && navigator.vibrate) navigator.vibrate(v === 'out' || v === 'fail' ? [80, 60, 80] : 40);
      }, revealDelay(i) * 1000 + 150);
    });
  }
  const revealDelay = (i) => 1.1 + i * 0.75;

  // ---------- Rendu ----------
  function render() {
    const a = document.activeElement;
    const focusId = a && a.id ? a.id : null;
    const sel = focusId && a.setSelectionRange && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;

    document.body.classList.toggle('tv', !!(S && S.isTv));
    let html;
    if (!S) html = viewHome();
    else if (S.isTv) html = viewTv();
    else if (S.phase === 'lobby') html = viewLobby();
    else html = viewGame();
    $app.innerHTML = html;

    $app.querySelectorAll('[data-draft]').forEach((el) => {
      const k = el.dataset.draft;
      if (drafts[k] !== undefined) el.value = drafts[k];
    });
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel && el.setSelectionRange) {
          try {
            el.setSelectionRange(sel[0], sel[1]);
          } catch {}
        }
      }
    }
    updateTimer();
  }

  // ----- Accueil -----
  function viewHome() {
    return `
    <main class="home">
      <header class="hero">
        <div class="hero-mic">🎤</div>
        <h1 class="logo">MASTER<span>GOON</span></h1>
        <p class="tagline">Ne dis <em>surtout pas</em> la même chose que lui.</p>
      </header>

      <section class="card">
        <label class="lbl" for="in-name">Ton pseudo</label>
        <div class="row">
          <button class="avatar-btn" data-action="avatar-next" title="Changer d'avatar" aria-label="Changer d'avatar">${esc(local.avatar)}</button>
          <input id="in-name" class="input" data-draft="name" maxlength="16" placeholder="Ex : Enzo" autocomplete="nickname" data-enter="${drafts.code.length === 4 ? 'join' : 'create'}" />
        </div>
        ${
          drafts.code.length === 4
            ? `<button class="btn btn-primary btn-big" data-action="join">Rejoindre la salle ${esc(drafts.code)}</button>
               <button class="btn btn-ghost" data-action="clear-code">Créer ma propre partie</button>`
            : `<button class="btn btn-primary btn-big" data-action="create">Créer une partie</button>
               <div class="divider"><span>ou rejoindre avec un code</span></div>
               <div class="row">
                 <input id="in-code" class="input code-input" data-draft="code" maxlength="4" placeholder="ABCD" autocapitalize="characters" autocomplete="off" data-enter="join" />
                 <button class="btn" data-action="join">Rejoindre</button>
               </div>`
        }
      </section>

      <details class="card rules">
        <summary>Comment on joue ?</summary>
        <ol>
          <li>À chaque tour, un joueur est le <b>Mastergoon</b> 🎤 (dans l'ordre d'arrivée).</li>
          <li>Une question tombe, par exemple « Donne-moi une couleur ». Le Mastergoon répond <b>en secret</b>.</li>
          <li>Les autres répondent aussi, mais <b>ne doivent pas dire la même chose</b> que lui. Le Mastergoon valide lui-même, donc pas de souci d'orthographe.</li>
          <li>Ceux qui disent pareil sont éliminés. Les survivants gagnent <b>+1 point</b> et on passe à une question plus serrée.</li>
          <li><b>Joker 🃏</b> : une fois éliminé, tu peux tenter de dire <b>exactement la même chose</b> que le Mastergoon sur la question de ton choix. Si tu réussis, tu reviens dans la partie (sans point pour cette question).</li>
          <li>Quand tout le monde est éliminé, on passe au Mastergoon suivant. Le plus de points à la fin gagne.</li>
          <li>Pas d'accord avec le Mastergoon ? <b>Contestez</b> : à la majorité, la décision est renversée.</li>
        </ol>
      </details>

      <p class="foot">
        <button class="link" data-action="tv-join">📺 Afficher une partie sur une TV</button>
      </p>
    </main>`;
  }

  // ----- Lobby -----
  function viewLobby() {
    const host = isHost();
    const s = S.settings;
    const players = S.players.filter((p) => !p.spectator);
    const dis = host ? '' : 'disabled';

    const seg = (key, options) =>
      `<div class="seg" role="group">${options
        .map(([val, label]) => `<button class="${String(s[key]) === String(val) ? 'on' : ''}" data-action="set" data-key="${key}" data-value="${val}" ${dis}>${label}</button>`)
        .join('')}</div>`;
    const stepper = (key, min, max) =>
      `<div class="stepper"><button data-action="step" data-key="${key}" data-delta="-1" ${dis} aria-label="Moins">−</button><b>${s[key]}</b><button data-action="step" data-key="${key}" data-delta="1" ${dis} aria-label="Plus">+</button></div>`;
    const toggle = (key, label, hint) =>
      `<label class="toggle"><input type="checkbox" data-action="toggle-opt" data-key="${key}" ${s[key] ? 'checked' : ''} ${dis} /><span class="sw"></span><span><b>${label}</b><small>${hint}</small></span></label>`;

    const customCount = s.customQuestions.length;
    const startHint = !S.canStart ? 'Il faut au moins 2 joueurs connectés.' : !S.poolSize ? 'Choisis au moins une catégorie.' : `${players.length} joueurs · ${S.poolSize} questions dispo`;

    return `
    <div class="lobby">
      ${topbar()}
      <section class="card code-card">
        <div class="code-label">Code de la salle</div>
        <div class="room-code" aria-label="Code ${esc(S.code)}">${[...S.code].map((c) => `<span>${esc(c)}</span>`).join('')}</div>
        <div class="row center wrap">
          <button class="btn btn-sm" data-action="copy-link">🔗 Copier le lien</button>
          <button class="btn btn-sm" data-action="toggle-qr">${local.showQr ? 'Masquer' : '📱 QR code'}</button>
          <button class="btn btn-sm" data-action="open-tv">📺 Mode TV</button>
        </div>
        ${local.showQr ? `<img class="qr" alt="QR code pour rejoindre" src="/api/qr?text=${encodeURIComponent(roomLink())}" />` : ''}
      </section>

      <section class="card">
        <h2>Joueurs <span class="count">${players.length}/12</span></h2>
        <ul class="plist">
          ${S.players
            .map(
              (p) => `<li class="${p.connected ? '' : 'off'}">
                ${avatarHtml(p)}
                <span class="pname">${esc(p.name)}${p.id === S.you ? ' <small>(toi)</small>' : ''}</span>
                ${p.id === S.hostId ? '<span class="tag tag-host">Hôte</span>' : ''}
                ${!p.connected ? '<span class="tag">hors ligne</span>' : ''}
                ${host && p.id !== S.you ? `<button class="icon-btn" data-action="kick" data-id="${p.id}" title="Exclure ${esc(p.name)}" aria-label="Exclure ${esc(p.name)}">✕</button>` : ''}
              </li>`,
            )
            .join('')}
        </ul>
        <p class="muted small">L'ordre d'arrivée décide qui sera Mastergoon en premier.</p>
      </section>

      <section class="card settings">
        <h2>Paramètres ${host ? '' : '<small class="muted">(seul l\'hôte peut modifier)</small>'}</h2>

        <div class="field">
          <div class="lbl">Catégories</div>
          <div class="chips">
            ${S.categories
              .map((c) => {
                const on = s.categories.includes(c.id);
                const extra = c.id === 'custom' ? ` (${customCount})` : '';
                return `<button class="chip ${on ? 'on' : ''}" data-action="toggle-cat" data-cat="${c.id}" ${dis}>${c.emoji} ${esc(c.label)}${extra}</button>`;
              })
              .join('')}
          </div>
        </div>

        <div class="field">
          <div class="lbl">Mode de jeu</div>
          ${seg('mode', [
            ['different', '🙅 Ne pas dire pareil'],
            ['same', '🤝 Dire pareil'],
          ])}
          <small class="muted">${s.mode === 'same' ? 'Variante : il faut dire la même chose que le Mastergoon. Le joker devient « dire autre chose ».' : 'Le mode classique.'}</small>
        </div>

        <div class="field two">
          <div><div class="lbl">Temps de réponse</div>${seg('answerTime', [10, 15, 20, 30, 45, 60].map((n) => [n, n + 's']))}</div>
        </div>
        <div class="field grid2">
          <div><div class="lbl">Manches</div>${stepper('rounds')}<small class="muted">1 manche = chacun est Mastergoon une fois</small></div>
          <div><div class="lbl">Questions max / tour</div>${stepper('maxQuestions')}<small class="muted">Les questions se resserrent au fil du tour</small></div>
        </div>
        <div class="field">
          <div class="lbl">Joker 🃏</div>
          ${seg('jokerScope', [
            ['turn', '1 par tour'],
            ['game', '1 par partie'],
          ])}
        </div>
        <div class="field toggles">
          ${toggle('playersMustDiffer', 'Joueurs différents entre eux', 'Deux joueurs qui disent pareil sont éliminés aussi')}
          ${toggle('speedBonus', 'Bonus rapidité', '+1 point au survivant le plus rapide')}
          ${toggle('showChoices', 'Afficher les réponses possibles', 'Pour les questions très serrées (ex : évolutions de Tiplouf)')}
        </div>
      </section>

      <section class="card custom">
        <h2>Questions perso <span class="count">${customCount}</span></h2>
        ${
          host
            ? `<div class="custom-form">
            <input id="cq-text" class="input" data-draft="cq_text" maxlength="120" placeholder="Ex : Donne-moi un perso de One Piece" data-enter="add-custom" />
            <div class="row">
              <select id="cq-level" class="input" data-draft="cq_level" aria-label="Difficulté">
                ${[1, 2, 3, 4, 5].map((l) => `<option value="${l}">Niveau ${l} · ${LEVEL_LABEL[l]}</option>`).join('')}
              </select>
              <button class="btn" data-action="add-custom">Ajouter</button>
            </div>
            <input id="cq-choices" class="input" data-draft="cq_choices" maxlength="400" placeholder="Réponses possibles (optionnel, séparées par des virgules)" data-enter="add-custom" />
          </div>`
            : ''
        }
        ${
          customCount
            ? `<ul class="cq-list">${s.customQuestions
                .map(
                  (q, i) => `<li><span class="lv">N${q.level}</span><span class="cq-t">${esc(q.text)}${q.choices ? `<small>${esc(q.choices.join(', '))}</small>` : ''}</span>${host ? `<button class="icon-btn" data-action="del-custom" data-i="${i}" aria-label="Supprimer">✕</button>` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<p class="muted small">Aucune question perso pour l\'instant.</p>'
        }
        <div class="row wrap">
          ${host ? `<label class="btn btn-sm">📥 Importer<input type="file" accept="application/json,.json" data-action="import-custom" hidden /></label>` : ''}
          ${customCount ? `<button class="btn btn-sm" data-action="export-custom">📤 Exporter</button>` : ''}
          ${host && customCount ? `<button class="btn btn-sm btn-ghost" data-action="clear-custom">Tout effacer</button>` : ''}
        </div>
        ${customCount && !s.categories.includes('custom') ? '<p class="warn small">Active la catégorie « Perso » pour les utiliser.</p>' : ''}
      </section>

      <div class="sticky-cta">
        ${
          host
            ? `<button class="btn btn-primary btn-big" data-action="start" ${S.canStart && S.poolSize ? '' : 'disabled'}>Lancer la partie</button><div class="muted small center">${startHint}</div>`
            : `<div class="waiting">⏳ En attente que <b>${esc((P(S.hostId) || {}).name || "l'hôte")}</b> lance la partie…</div>`
        }
      </div>
    </div>`;
  }

  function topbar(extra = '') {
    return `<header class="topbar">
      <div class="logo logo-sm">MASTER<span>GOON</span></div>
      ${extra}
      <div class="row tight">
        <button class="icon-btn" data-action="mute" title="Son" aria-label="Activer ou couper le son">${Sound.isMuted() ? '🔇' : '🔊'}</button>
        ${S && !S.isTv ? '<button class="icon-btn" data-action="leave" title="Quitter" aria-label="Quitter la partie">🚪</button>' : ''}
      </div>
    </header>`;
  }

  // ----- Jeu -----
  function viewGame() {
    const mg = P(S.mastergoonId);
    let body = '';
    switch (S.phase) {
      case 'turnIntro':
        body = viewTurnIntro(mg);
        break;
      case 'answering':
        body = viewAnswering();
        break;
      case 'validating':
        body = viewValidating();
        break;
      case 'reveal':
        body = viewReveal();
        break;
      case 'turnEnd':
        body = viewTurnEnd();
        break;
      case 'gameEnd':
        body = viewGameEnd();
        break;
    }
    const meta =
      S.phase === 'gameEnd'
        ? ''
        : `<div class="meta"><span>Manche <b>${S.manche}</b>/${S.rounds}</span><span>Tour <b>${S.turnIndex + 1}</b>/${S.turnsInManche}</span></div>`;
    return `
    <div class="game phase-${S.phase}">
      ${topbar(meta)}
      <main class="stage">${body}</main>
      ${S.phase === 'gameEnd' ? '' : playersStrip()}
      ${reactionBar()}
      ${isHost() && ['turnIntro', 'answering', 'validating', 'reveal'].includes(S.phase) ? '<button class="skip-turn" data-action="skip-turn">⏭ Passer ce tour (hôte)</button>' : ''}
    </div>`;
  }

  function viewTurnIntro(mg) {
    const you = isMg();
    return `
    <section class="intro">
      <div class="intro-label">${you ? "C'est toi le" : 'Nouveau'}</div>
      <div class="intro-title">MASTER<span>GOON</span></div>
      <div class="intro-avatar">${avatarHtml(mg, 'xl')}</div>
      <div class="intro-name">${esc(mg ? mg.name : '')}</div>
      <p class="intro-sub">${
        you
          ? 'Réponds en secret à chaque question. Essaie de dire ce que les autres vont dire !'
          : sameMode()
            ? `Dites <b>la même chose</b> que ${esc(mgName())} pour survivre.`
            : `Ne dites <b>surtout pas</b> la même chose que ${esc(mgName())}.`
      }</p>
      ${canDrive() ? '<button class="btn btn-primary" data-action="advance">C\'est parti →</button>' : ''}
    </section>`;
  }

  function questionHead() {
    const q = S.question;
    return `
      <div class="q-head">
        <span class="q-num">Question ${S.qIndex + 1}<small>/${S.maxQuestions}</small></span>
        <span class="q-cat">${catLabel(q.cat)}</span>
      </div>
      <h2 class="question">${esc(q.text)}</h2>
      <div class="q-sub">${levelDots(q.level)}</div>`;
  }

  function timerHtml() {
    return `<div class="timer" id="timer" style="--p:1"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" class="track"/><circle cx="22" cy="22" r="19" class="bar"/></svg><span id="timer-num">–</span></div>`;
  }

  function choicesHtml(clickable) {
    const c = S.question && S.question.choices;
    if (!c) return '';
    return `<div class="choices">${c
      .map((x) => (clickable ? `<button class="choice" data-action="choice" data-value="${esc(x)}">${esc(x)}</button>` : `<span class="choice">${esc(x)}</span>`))
      .join('')}</div>`;
  }

  function answerForm(opts) {
    return `
      <form class="answer-form ${opts.cls || ''}" data-action="answer" data-joker="${opts.joker ? '1' : ''}" autocomplete="off">
        <label class="lbl" for="in-answer">${opts.label}</label>
        <div class="row">
          <input id="in-answer" class="input input-big" data-draft="answer" maxlength="40" placeholder="${esc(opts.placeholder || 'Ta réponse')}" enterkeyhint="send" autocomplete="off" autocorrect="off" spellcheck="false" />
          <button class="btn btn-primary" type="submit">${opts.button}</button>
        </div>
        ${S.yourAnswer ? `<div class="sent">${opts.sentLabel} <b>${esc(S.yourAnswer)}</b> <small>(modifiable jusqu'à la fin du temps)</small></div>` : ''}
      </form>`;
  }

  function viewAnswering() {
    const m = me();
    let panel = '';
    let clickable = false;
    if (!m || m.spectator) {
      panel = `<div class="note">👀 Tu regardes la partie. Tu joueras dès la prochaine manche.</div>`;
    } else if (isMg()) {
      clickable = true;
      panel = answerForm({ label: 'Ta réponse secrète 🤫', button: S.yourAnswer ? 'Changer' : 'Verrouiller', sentLabel: '🔒 Verrouillé :', cls: 'mg' });
    } else if (S.isParticipant) {
      clickable = true;
      panel = answerForm({
        label: sameMode() ? `Dis la même chose que ${esc(mgName())} !` : `Ne dis pas la même chose que ${esc(mgName())} !`,
        button: S.yourAnswer ? 'Changer' : 'Envoyer',
        sentLabel: '✅ Envoyé :',
      });
    } else if (S.canJoker && (S.jokerActive || local.jokerOpen)) {
      clickable = true;
      panel = answerForm({
        label: sameMode() ? `🃏 Joker : dis autre chose que ${esc(mgName())} pour revenir !` : `🃏 Joker : devine EXACTEMENT ce que dit ${esc(mgName())} !`,
        button: 'Tenter',
        sentLabel: '🃏 Joker joué :',
        joker: true,
        cls: 'joker',
      });
    } else if (S.canJoker && !S.jokerPassed) {
      panel = `
        <div class="joker-offer">
          <div class="joker-card">🃏</div>
          <div>
            <b>Tu es éliminé… mais il te reste ton joker !</b>
            <p>${sameMode() ? `Dis <b>autre chose</b> que ${esc(mgName())}` : `Dis <b>exactement la même chose</b> que ${esc(mgName())}`} sur cette question et tu reviens dans la partie (sans gagner de point dessus).</p>
            <div class="row wrap">
              <button class="btn btn-joker" data-action="use-joker">Utiliser mon joker</button>
              <button class="btn btn-ghost" data-action="pass-joker">Pas cette fois</button>
            </div>
          </div>
        </div>`;
    } else if (S.canJoker && S.jokerPassed) {
      panel = `<div class="note">🃏 Tu gardes ton joker pour une prochaine question.</div>`;
    } else {
      panel = `<div class="note">💀 Tu es éliminé pour ce tour. Profite du spectacle 🍿</div>`;
    }

    const waiting = S.players.filter((p) => !p.spectator && (p.id === S.mastergoonId || p.alive || p.jokerActive));
    return `
      <section class="play">
        <div class="play-top">${timerHtml()}</div>
        ${questionHead()}
        ${choicesHtml(clickable)}
        ${panel}
        <div class="answered">
          ${waiting
            .map(
              (p) =>
                `<span class="ans-chip ${p.answered ? 'done' : ''}">${esc(p.avatar)} ${esc(p.name)}${p.id === S.mastergoonId ? ' 🎤' : ''}${p.jokerActive ? ' 🃏' : ''} ${p.answered ? '✓' : '…'}</span>`,
            )
            .join('')}
        </div>
      </section>`;
  }

  function verdictButtons(e) {
    if (e.locked) return '<span class="tag">⏰ Pas de réponse : éliminé</span>';
    const b = (v, label, cls = '') =>
      `<button class="vbtn ${cls} ${e.verdict === v || (v === 'invalid' && e.reason === 'invalid') || (v === 'dup' && e.reason === 'dup') ? 'on' : ''}" data-action="decide" data-id="${e.pid}" data-verdict="${v}">${label}</button>`;
    if (e.joker) return b('revive', '🃏 Pareil, il revient', 'good') + b('fail', '❌ Raté', 'bad');
    const outIsOn = e.verdict === 'out' && (e.reason === 'same' || e.reason === 'diff');
    const outBtn = `<button class="vbtn bad ${outIsOn ? 'on' : ''}" data-action="decide" data-id="${e.pid}" data-verdict="out">${sameMode() ? '❌ Différent' : '❌ Pareil'}</button>`;
    return (
      `<button class="vbtn good ${e.verdict === 'survive' ? 'on' : ''}" data-action="decide" data-id="${e.pid}" data-verdict="survive">${sameMode() ? '✅ Pareil' : '✅ Différent'}</button>` +
      outBtn +
      (S.settings.playersMustDiffer ? b('dup', '👯 Doublon', 'bad') : '') +
      b('invalid', '🚫 Invalide', 'bad')
    );
  }

  function viewValidating() {
    if (!S.youValidate) {
      return `
        <section class="suspense">
          ${questionHead()}
          <div class="suspense-box">
            <div class="spinner"></div>
            <p><b>${esc((P(S.validatorId) || {}).name || mgName())}</b> vérifie les réponses…</p>
          </div>
        </section>`;
    }
    return `
      <section class="validate">
        ${questionHead()}
        <div class="mg-answer small"><span>Ta réponse</span><b>${esc(S.mgAnswer)}</b></div>
        <p class="muted small">${
          sameMode() ? 'Vérifie qui a bien dit la même chose que toi.' : 'Vérifie qui a dit la même chose que toi (les fautes d\'orthographe, c\'est toi qui juges).'
        } Les suggestions sont pré-cochées.</p>
        <ul class="vlist">
          ${S.entries
            .map((e) => {
              const p = P(e.pid);
              return `<li class="${e.joker ? 'is-joker' : ''}">
                <div class="vwho">${avatarHtml(p)} <span>${esc(p ? p.name : '?')}</span>${e.joker ? '<span class="tag tag-joker">Joker</span>' : ''}</div>
                <div class="vtext">${e.text ? esc(e.text) : '<i class="muted">—</i>'}</div>
                <div class="vbtns">${verdictButtons(e)}</div>
              </li>`;
            })
            .join('')}
        </ul>
        <button class="btn btn-primary btn-big" data-action="confirm-validation">Révéler les résultats</button>
      </section>`;
  }

  function verdictBadge(e) {
    const v = e.finalVerdict;
    if (e.locked) return '<span class="badge out">⏰ Trop tard</span>';
    if (v === 'survive') return '<span class="badge good">Survit +1</span>';
    if (v === 'revive') return '<span class="badge joker">🃏 De retour !</span>';
    if (v === 'fail') return '<span class="badge out">Joker raté</span>';
    if (e.reason === 'invalid' && !e.flipped) return '<span class="badge out">🚫 Invalide</span>';
    if (e.reason === 'dup' && !e.flipped) return '<span class="badge out">👯 Doublon</span>';
    return '<span class="badge out">💀 Éliminé</span>';
  }

  function viewReveal() {
    // si l'écran est redessiné pendant l'animation, on la reprend où elle en était
    const elapsed = (Date.now() - (revealStarts[S.revealKey] || 0)) / 1000;
    const animate = elapsed < revealDelay(S.entries ? S.entries.length : 0) + 1;
    const mg = P(S.mastergoonId);
    if (S.mgTimeout) {
      return `<section class="reveal">
        ${questionHead()}
        <div class="note big">😴 ${esc(mgName())} n'a pas répondu à temps. Question annulée, personne n'est éliminé.</div>
        ${advanceBtn('Question suivante →')}
      </section>`;
    }
    const rows = S.entries
      .map((e, i) => {
        const p = P(e.pid);
        const style = animate ? `style="animation-delay:${(revealDelay(i) - elapsed).toFixed(2)}s"` : '';
        const contest =
          !S.isTv && (e.canContest || e.contests)
            ? `<button class="contest ${e.youContested ? 'on' : ''}" data-action="contest" data-id="${e.pid}" ${e.canContest ? '' : 'disabled'} title="Contester cette décision">⚖️ ${e.contests}/${e.eligible}</button>`
            : '';
        return `<li class="rrow v-${e.finalVerdict} ${animate ? 'anim' : ''} ${e.pid === S.you ? 'mine' : ''}" ${style}>
          ${avatarHtml(p)}
          <div class="rmain"><span class="rname">${esc(p ? p.name : '?')}${e.joker ? ' <span class="tag tag-joker">Joker</span>' : ''}</span><span class="rtext">${e.text ? esc(e.text) : '<i>—</i>'}</span></div>
          <div class="rside">${verdictBadge(e)}${e.flipped ? '<span class="flipped">Renversé par vote</span>' : ''}${contest}</div>
        </li>`;
      })
      .join('');
    return `
      <section class="reveal">
        ${questionHead()}
        <div class="mg-answer ${animate ? 'anim' : ''}" ${animate ? `style="animation-delay:${(0.15 - elapsed).toFixed(2)}s"` : ''}>
          <span>${avatarHtml(mg)} ${esc(mgName())} a dit</span>
          <b>${esc(S.mgAnswer)}</b>
        </div>
        <ul class="rlist">${rows}</ul>
        ${S.entries.some((e) => !e.locked) && !S.isTv ? '<p class="muted small center">Pas d\'accord avec une décision ? Contestez-la ⚖️ : à la majorité, elle est renversée.</p>' : ''}
        ${advanceBtn('Question suivante →')}
      </section>`;
  }

  function advanceBtn(label) {
    if (S.isTv) return '';
    if (canDrive()) return `<button class="btn btn-primary btn-big" data-action="advance">${label}</button>`;
    return `<div class="waiting">⏳ En attente de ${esc(mgName())}…</div>`;
  }

  function scoreboard(highlight = true) {
    const ps = S.players.filter((p) => !p.spectator).sort((a, b) => b.score - a.score);
    let rank = 0;
    let prev = null;
    return `<ol class="board">${ps
      .map((p, i) => {
        if (p.score !== prev) rank = i + 1;
        prev = p.score;
        return `<li class="${highlight && p.id === S.you ? 'mine' : ''}"><span class="rk">${rank}</span>${avatarHtml(p)}<span class="bn">${esc(p.name)}</span><span class="bs">${p.score} pt${p.score > 1 ? 's' : ''}</span></li>`;
      })
      .join('')}</ol>`;
  }

  function viewTurnEnd() {
    const t = S.turnSummary || {};
    return `
      <section class="turnend">
        <div class="intro-label">Fin du tour de</div>
        <div class="te-name">${esc(t.mgAvatar || '')} ${esc(t.mgName || '')}</div>
        <p class="muted">${t.questions || 0} question${t.questions > 1 ? 's' : ''} jouée${t.questions > 1 ? 's' : ''}</p>
        ${scoreboard()}
        ${advanceBtn(t.isLastTurn ? 'Voir les résultats 🏆' : 'Mastergoon suivant →')}
      </section>`;
  }

  function viewGameEnd() {
    const ps = S.players.filter((p) => !p.spectator).sort((a, b) => b.score - a.score);
    const [p1, p2, p3] = ps;
    const pod = (p, place) =>
      p ? `<div class="pod pod-${place}">${avatarHtml(p, 'lg')}<div class="pod-name">${esc(p.name)}</div><div class="pod-score">${p.score} pt${p.score > 1 ? 's' : ''}</div><div class="pod-step">${place}</div></div>` : '<div class="pod"></div>';
    const awards = (S.awards || [])
      .map((a) => `<div class="award"><div class="aw-emoji">${a.emoji}</div><div><b>${esc(a.title)}</b><div>${esc(a.avatar)} ${esc(a.name)}</div><small>${esc(a.desc)}</small></div></div>`)
      .join('');
    const reasonText = (r) =>
      r.joker
        ? r.verdict === 'revive'
          ? '🃏 revient'
          : '🃏 raté'
        : r.verdict === 'survive'
          ? `+${r.points}${r.fastest ? ' ⚡' : ''}`
          : r.reason === 'timeout'
            ? '⏰'
            : '💀';
    const history = (S.history || [])
      .map(
        (t) => `<details class="hist-turn"><summary>Manche ${t.manche} · ${esc(t.mgAvatar)} ${esc(t.mgName)} <small>${t.questions.length} question(s)</small></summary>
          ${t.questions
            .map(
              (q) => `<div class="hist-q"><div class="hq-t">${esc(q.text)}</div>
                ${q.mgTimeout ? '<div class="muted small">Le Mastergoon n\'a pas répondu</div>' : `<div class="hq-mg">🎤 <b>${esc(q.mgAnswer)}</b></div>`}
                <div class="hq-ans">${q.answers
                  .map((r) => `<span class="hq-a ${r.verdict === 'survive' || r.verdict === 'revive' ? 'ok' : 'ko'}">${esc(r.avatar)} ${esc(r.name)} : ${r.text ? esc(r.text) : '—'} <b>${reasonText(r)}</b></span>`)
                  .join('')}</div></div>`,
            )
            .join('')}
        </details>`,
      )
      .join('');
    return `
      <section class="gameend">
        <div class="intro-label">Fin de la partie</div>
        <h2 class="winner">🏆 ${esc(p1 ? p1.name : '')} gagne !</h2>
        <div class="podium">${pod(p2, 2)}${pod(p1, 1)}${pod(p3, 3)}</div>
        ${scoreboard()}
        ${awards ? `<h3>Les trophées</h3><div class="awards">${awards}</div>` : ''}
        <h3>Récap de la partie</h3>
        <div class="history">${history || '<p class="muted">Rien à afficher.</p>'}</div>
        ${
          S.isTv
            ? ''
            : `<div class="row center wrap end-actions">
          ${isHost() ? '<button class="btn btn-primary btn-big" data-action="back-lobby">🔁 Rejouer</button>' : '<div class="waiting">L\'hôte peut relancer une partie.</div>'}
          <button class="btn btn-ghost" data-action="leave">Quitter</button>
        </div>`
        }
      </section>`;
  }

  function playersStrip() {
    const ps = S.players.filter((p) => !p.spectator);
    return `<aside class="strip" aria-label="Joueurs">${ps
      .map((p) => {
        const isMgP = p.id === S.mastergoonId;
        const dead = !isMgP && !p.alive;
        const joker = !isMgP && !p.jokerUsed;
        return `<div class="sp ${dead ? 'dead' : ''} ${isMgP ? 'is-mg' : ''} ${p.connected ? '' : 'off'} ${p.id === S.you ? 'mine' : ''}">
          ${avatarHtml(p)}
          <span class="sp-name">${esc(p.name)}</span>
          <span class="sp-score">${p.score}</span>
          <span class="sp-icons">${isMgP ? '🎤' : ''}${dead ? '💀' : ''}${joker ? '<span title="Joker disponible">🃏</span>' : ''}${p.connected ? '' : '📴'}${S.phase === 'answering' && p.answered ? '✓' : ''}</span>
        </div>`;
      })
      .join('')}</aside>`;
  }

  function reactionBar() {
    if (S.isTv || !S.you) return '';
    return `<div class="react-bar">${S.reactions.map((e) => `<button data-action="react" data-emoji="${e}" aria-label="Réaction ${e}">${e}</button>`).join('')}</div>`;
  }

  // ----- Mode TV -----
  function viewTv() {
    if (S.phase === 'lobby') {
      const link = roomLink();
      return `
      <div class="tv-lobby">
        <div>
          <h1 class="logo">MASTER<span>GOON</span></h1>
          <p class="tagline">Rejoins sur <b>${esc(location.host)}</b> avec le code</p>
          <div class="room-code xl">${[...S.code].map((c) => `<span>${esc(c)}</span>`).join('')}</div>
          <ul class="plist tv-plist">${S.players.map((p) => `<li>${avatarHtml(p)}<span class="pname">${esc(p.name)}</span></li>`).join('')}</ul>
        </div>
        <img class="qr qr-xl" alt="QR code" src="/api/qr?text=${encodeURIComponent(link)}" />
      </div>`;
    }
    return viewGame();
  }

  // ---------- Timer ----------
  function updateTimer() {
    const el = document.getElementById('timer');
    if (!el || !S || S.phase !== 'answering') return;
    const rem = Math.max(0, deadlineLocal - Date.now());
    const p = S.totalMs ? rem / S.totalMs : 0;
    el.style.setProperty('--p', p.toFixed(3));
    const sec = Math.ceil(rem / 1000);
    const num = document.getElementById('timer-num');
    if (num) num.textContent = sec;
    el.classList.toggle('urgent', sec <= 5);
    if (sec !== lastSecond) {
      if (lastSecond !== null && sec > 0 && sec <= 5) Sound.tickUrgent();
      lastSecond = sec;
    }
  }
  setInterval(updateTimer, 150);

  // ---------- Réactions ----------
  function floatReaction(emoji, p) {
    const el = document.createElement('div');
    el.className = 'float-react';
    el.style.left = 8 + Math.random() * 84 + '%';
    el.innerHTML = `<span class="fe">${esc(emoji)}</span>${p ? `<span class="fn">${esc(p.name)}</span>` : ''}`;
    $reactions.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- Actions ----------
  function saveSession(r) {
    store.set('mg_session', { code: r.code, token: r.token });
    history.replaceState(null, '', `/?room=${r.code}`);
  }

  function setSetting(patch) {
    socket.emit('updateSettings', patch);
  }

  function sendAnswer(joker) {
    const text = (drafts.answer || '').trim();
    if (!text) {
      toast('Écris une réponse !');
      return;
    }
    socket.emit('answer', { text, joker: !!joker });
    Sound.send();
    if (navigator.vibrate) navigator.vibrate(20);
  }

  function exportCustom() {
    const data = JSON.stringify(
      { app: 'mastergoon', version: 1, questions: S.settings.customQuestions.map(({ text, level, choices }) => ({ text, level, choices })) },
      null,
      2,
    );
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mastergoon-questions.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importCustom(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        const list = Array.isArray(json) ? json : json.questions;
        if (!Array.isArray(list)) throw new Error();
        const merged = [...S.settings.customQuestions, ...list].slice(0, 200);
        const cats = S.settings.categories.includes('custom') ? S.settings.categories : [...S.settings.categories, 'custom'];
        setSetting({ customQuestions: merged, categories: cats });
        toast(`${list.length} question(s) importée(s)`);
      } catch {
        toast('Fichier invalide');
      }
    };
    reader.readAsText(file);
  }

  const actions = {
    'avatar-next'() {
      const i = AVATARS.indexOf(local.avatar);
      local.avatar = AVATARS[(i + 1) % AVATARS.length];
      store.set('mg_avatar', local.avatar);
      render();
    },
    'clear-code'() {
      drafts.code = '';
      history.replaceState(null, '', '/');
      render();
    },
    create() {
      const name = (drafts.name || '').trim();
      if (!name) return toast("Choisis d'abord un pseudo");
      store.set('mg_name', name);
      socket.emit('createRoom', { name, avatar: local.avatar }, (r) => {
        if (r.error) return toast(r.error);
        saveSession(r);
      });
    },
    join() {
      const name = (drafts.name || '').trim();
      const code = (drafts.code || '').trim().toUpperCase();
      if (!name) return toast("Choisis d'abord un pseudo");
      if (code.length !== 4) return toast('Le code fait 4 lettres');
      store.set('mg_name', name);
      socket.emit('joinRoom', { code, name, avatar: local.avatar }, (r) => {
        if (r.error) return toast(r.error);
        saveSession(r);
        if (r.spectator) toast('Partie en cours : tu joueras dès la prochaine manche 👀', 4000);
      });
    },
    'tv-join'() {
      const code = (drafts.code || prompt('Code de la salle à afficher ?') || '').trim().toUpperCase();
      if (code.length !== 4) return toast('Le code fait 4 lettres');
      location.href = `/?tv=${code}`;
    },
    'copy-link'() {
      const link = roomLink();
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'Mastergoon', text: `Rejoins ma partie de Mastergoon (code ${S.code})`, url: link }).catch(() => {});
        return;
      }
      navigator.clipboard
        .writeText(link)
        .then(() => toast('Lien copié !'))
        .catch(() => toast(link, 5000));
    },
    'toggle-qr'() {
      local.showQr = !local.showQr;
      render();
    },
    'open-tv'() {
      window.open(`/?tv=${S.code}`, '_blank');
    },
    mute() {
      Sound.toggle();
      render();
    },
    leave() {
      if (S && S.phase !== 'lobby' && S.phase !== 'gameEnd' && !confirm('Quitter la partie en cours ?')) return;
      socket.emit('leave');
      store.del('mg_session');
      S = null;
      history.replaceState(null, '', '/');
      drafts.code = '';
      render();
    },
    kick(el) {
      const p = P(el.dataset.id);
      if (p && confirm(`Exclure ${p.name} ?`)) socket.emit('kick', p.id);
    },
    set(el) {
      const k = el.dataset.key;
      const raw = el.dataset.value;
      setSetting({ [k]: /^\d+$/.test(raw) ? Number(raw) : raw });
    },
    step(el) {
      const k = el.dataset.key;
      setSetting({ [k]: S.settings[k] + Number(el.dataset.delta) });
    },
    'toggle-opt'(el) {
      setSetting({ [el.dataset.key]: el.checked });
    },
    'toggle-cat'(el) {
      const c = el.dataset.cat;
      const cur = S.settings.categories;
      setSetting({ categories: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] });
    },
    'add-custom'() {
      const text = (drafts.cq_text || '').trim();
      if (!text) return toast('Écris une question');
      const choices = (drafts.cq_choices || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const q = { text, level: Number(drafts.cq_level) || 3, choices: choices.length ? choices : null };
      const cats = S.settings.categories.includes('custom') ? S.settings.categories : [...S.settings.categories, 'custom'];
      setSetting({ customQuestions: [...S.settings.customQuestions, q], categories: cats });
      drafts.cq_text = '';
      drafts.cq_choices = '';
      // garde aussi une copie locale pour les prochaines parties
      store.set('mg_custom', [...S.settings.customQuestions, q].map(({ text, level, choices }) => ({ text, level, choices })));
    },
    'del-custom'(el) {
      const i = Number(el.dataset.i);
      const list = S.settings.customQuestions.filter((_, j) => j !== i);
      setSetting({ customQuestions: list });
      store.set('mg_custom', list.map(({ text, level, choices }) => ({ text, level, choices })));
    },
    'clear-custom'() {
      if (!confirm('Effacer toutes les questions perso ?')) return;
      setSetting({ customQuestions: [] });
      store.set('mg_custom', []);
    },
    'export-custom'() {
      exportCustom();
    },
    start() {
      socket.emit('start', (r) => r && r.error && toast(r.error));
    },
    choice(el) {
      drafts.answer = el.dataset.value;
      const form = document.querySelector('.answer-form');
      sendAnswer(form && form.dataset.joker === '1');
      render();
    },
    'use-joker'() {
      local.jokerOpen = true;
      render();
      const i = document.getElementById('in-answer');
      if (i) i.focus();
    },
    'pass-joker'() {
      socket.emit('passJoker');
    },
    decide(el) {
      socket.emit('decide', { pid: el.dataset.id, verdict: el.dataset.verdict });
    },
    'confirm-validation'() {
      socket.emit('confirmValidation');
    },
    contest(el) {
      socket.emit('contest', el.dataset.id);
    },
    advance() {
      socket.emit('advance');
    },
    'skip-turn'() {
      if (confirm('Passer directement au Mastergoon suivant ?')) socket.emit('skipTurn');
    },
    'back-lobby'() {
      socket.emit('backToLobby');
    },
    react(el) {
      socket.emit('react', el.dataset.emoji);
    },
  };

  document.addEventListener('click', (ev) => {
    Sound.unlock();
    const el = ev.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
    if (el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) {
      ev.preventDefault();
      fn(el);
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches('input[type=checkbox][data-action]')) actions[el.dataset.action](el);
    if (el.matches('input[type=file][data-action="import-custom"]') && el.files[0]) importCustom(el.files[0]);
    if (el.matches('select[data-draft]')) drafts[el.dataset.draft] = el.value;
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.dataset || !el.dataset.draft) return;
    let v = el.value;
    if (el.dataset.draft === 'code') {
      v = v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      el.value = v;
    }
    drafts[el.dataset.draft] = v;
  });

  document.addEventListener('submit', (ev) => {
    const f = ev.target;
    if (f.dataset.action === 'answer') {
      ev.preventDefault();
      sendAnswer(f.dataset.joker === '1');
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const el = ev.target;
    if (el.dataset && el.dataset.enter && actions[el.dataset.enter]) {
      ev.preventDefault();
      actions[el.dataset.enter](el);
    }
  });

  // Reprendre les questions perso sauvegardées quand on crée une salle
  const savedCustom = store.get('mg_custom', []);
  let restoredCustom = false;
  socket.on('state', (st) => {
    if (restoredCustom || st.phase !== 'lobby' || st.you !== st.hostId) return;
    restoredCustom = true;
    if (savedCustom.length && !st.settings.customQuestions.length) socket.emit('updateSettings', { customQuestions: savedCustom });
  });

  render();
})();
