// Petits sons synthétisés (aucun fichier audio nécessaire)
window.Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('mg_muted') === '1'; } catch {}

  function ac() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur = 0.12, type = 'sine', vol = 0.15, when = 0, slideTo = null) {
    if (muted) return;
    const c = ac();
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  const api = {
    unlock() { ac(); },
    isMuted: () => muted,
    toggle() {
      muted = !muted;
      try { localStorage.setItem('mg_muted', muted ? '1' : '0'); } catch {}
      return muted;
    },
    tick() { tone(900, 0.05, 'square', 0.05); },
    tickUrgent() { tone(1300, 0.07, 'square', 0.08); },
    send() { tone(520, 0.08, 'triangle', 0.12); tone(780, 0.1, 'triangle', 0.12, 0.06); },
    question() { tone(440, 0.1, 'triangle', 0.12); tone(660, 0.14, 'triangle', 0.12, 0.09); },
    pop() { tone(620, 0.07, 'sine', 0.12, 0, 900); },
    eliminated() { tone(300, 0.35, 'sawtooth', 0.09, 0, 90); },
    survive() { tone(660, 0.09, 'triangle', 0.1); tone(990, 0.12, 'triangle', 0.1, 0.07); },
    joker() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.1, i * 0.07)); },
    fanfare() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.12, i * 0.13)); },
    mastergoon() { tone(220, 0.25, 'sawtooth', 0.07, 0, 440); tone(440, 0.3, 'triangle', 0.1, 0.22); },
  };
  return api;
})();
