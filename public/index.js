(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let MAX_CHARS = 4000; // replaced by the server's limit (see /api/config below)
  const SAMPLE_TITLE = "Bob's Rocket Day";
  const SAMPLE = 'Bob was a fifteen-year-old boy who loved building model rockets in the garage.\n"Grandma, have you seen my key?" asked Bob.\nGrandma Rose, who was seventy-eight and never missed anything, smiled over her knitting. "Under the cushion, dear. You always forget," she said.\nMr. Hale, the stern old schoolteacher from next door, knocked and stepped inside. "Bob, you are late for the rocket club," he said sternly.\n"I\'m coming!" cried Bob, and he ran out into the sunshine.';

  /* ---------- tiny storage helper (may be blocked, so always try/catch) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('vt_' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('vt_' + k, JSON.stringify(v)); } catch (_) {} },
  };
  const settings = { theme: store.get('theme', 'auto'), back: store.get('back', 10), fwd: store.get('fwd', 10), autoplay: store.get('autoplay', true) };

  /* = state  */
  let segments = [], cast = {}, profiles = {}, title = '', voicesList = null;
  let idx = 0, playing = false, loading = false, finished = false, token = 0;
  let curMode = null;               // 'audio' | 'speech' | null (nothing loaded for current line)
  let useBrowserVoice = false;
  let rate = 1, volume = 1, sleepTimeout = null;
  let speechFrac = 0, pendingOffset = 0, dragging = false;
  const durations = [];             // real  lengths, filled in as clips load
  const audioPromises = {};         // index -> Promise<blob url>
  const player = new Audio();
  player.preload = 'auto';

  /*  helpers  */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (t) => { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const est = (i) => Math.max(1.5, segments[i].text.trim().split(/\s+/).length / 2.6); // rough seconds before the clip is loaded
  const dur = (i) => (Number.isFinite(durations[i]) ? durations[i] : est(i));
  const total = () => segments.reduce((a, _, i) => a + dur(i), 0);
  const prefix = (i) => { let a = 0; for (let j = 0; j < i; j++) a += dur(j); return a; };
  const allKnown = () => segments.every((_, i) => Number.isFinite(durations[i]));
  let toastTimer;
  function toast(msg, ms = 5000) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }

  /*  theme and settings panel  */
  function applySettings() {
    document.documentElement.dataset.theme = settings.theme;
    $('backN').textContent = settings.back; $('fwdN').textContent = settings.fwd;
    $('autoplay').checked = settings.autoplay;
    document.querySelectorAll('#settingsPanel .group').forEach((g) => {
      const cur = String(settings[g.dataset.key]);
      g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
    });
  }
  document.querySelectorAll('#settingsPanel .group').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = g.dataset.key; settings[k] = g.hasAttribute('data-num') ? Number(b.dataset.v) : b.dataset.v;
    store.set(k, settings[k]); applySettings();
  }));
  $('autoplay').addEventListener('change', (e) => { settings.autoplay = e.target.checked; store.set('autoplay', settings.autoplay); });

  /*  panels  */
  const panels = { settings: $('settingsPanel'), cast: $('castPanel') };
  function togglePanel(name) {
    const open = !panels[name].hidden;
    Object.values(panels).forEach((p) => (p.hidden = true));
    if (!open) { panels[name].hidden = false; if (name === 'cast') { renderCast(); scrollActive(); } }
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => Object.values(panels).forEach((p) => (p.hidden = true))));
  $('settingsBtn').onclick = () => togglePanel('settings');
  $('listBtn').onclick = () => togglePanel('cast');

  /*  popovers (volume / speed / sleep)  */
  const pops = [$('volPop'), $('speedPop'), $('sleepPop')];
  function togglePop(p) { const o = !p.hidden; pops.forEach((x) => (x.hidden = true)); p.hidden = o; }
  document.addEventListener('click', (e) => { if (!e.target.closest('.tool')) pops.forEach((x) => (x.hidden = true)); });
  $('volBtn').onclick = () => togglePop($('volPop'));
  $('speedBtn').onclick = () => togglePop($('speedPop'));
  $('sleepBtn').onclick = () => togglePop($('sleepPop'));
  $('vol').addEventListener('input', (e) => { volume = e.target.value / 100; player.volume = volume; });

  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  $('speedPop').innerHTML = SPEEDS.map((s) => `<button data-s="${s}">${s}×</button>`).join('');
  function refreshSpeed() {
    $('speedLbl').textContent = rate + '×';
    $('speedPop').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.s) === rate));
  }
  $('speedPop').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    rate = Number(b.dataset.s); player.defaultPlaybackRate = rate; player.playbackRate = rate; refreshSpeed(); $('speedPop').hidden = true;
  });
  refreshSpeed();

  const SLEEPS = [['Off', 0], ['5 minutes', 5], ['15 minutes', 15], ['30 minutes', 30], ['60 minutes', 60]];
  $('sleepPop').innerHTML = SLEEPS.map(([l, m]) => `<button data-m="${m}">${l}</button>`).join('');
  $('sleepPop').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const m = Number(b.dataset.m); clearTimeout(sleepTimeout);
    $('sleepLbl').textContent = m ? m + 'm' : ' ';
    $('sleepPop').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    if (m) sleepTimeout = setTimeout(() => { if (playing) togglePlay(); $('sleepLbl').innerHTML = '&nbsp;'; toast('Sleep timer ended'); }, m * 60000);
    $('sleepPop').hidden = true;
  });

  /*  cover art (generated, original)  */
  function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function renderCover(t) {
    const h = hash(t) % 360, ink = `hsl(${h},45%,26%)`;
    const bars = Array.from({ length: 17 }, (_, i) => 6 + ((hash(t + i) % 100) / 100) * 22);
    const size = t.length > 40 ? 15 : t.length > 22 ? 19 : 24;
    $('cover').style.cssText = `background:hsl(${h},32%,89%);color:${ink};border:3px solid ${ink};outline:1px solid ${ink};outline-offset:-8px`;
    $('cover').innerHTML = `<div><span class="cm">A full-cast audiobook</span>
      <span class="ct" style="font-size:${size}px">${esc(t)}</span>
      <svg class="wave" viewBox="0 0 68 34" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${bars.map((b, i) => `<rect x="${i * 4}" y="${17 - b / 2}" width="2.4" height="${b}" rx="1.2" fill="${ink}"/>`).join('')}</svg>
      <span class="cm">VoxTale</span></div>`;
  }

  /* =] views = */
  function showView(name) {
    $('inputView').hidden = name !== 'input'; $('playerView').hidden = name !== 'player';
    $('backBtn').hidden = name !== 'player'; $('topSpacer').hidden = name === 'player';
    Object.values(panels).forEach((p) => (p.hidden = true));
  }
  $('backBtn').onclick = () => { token++; stopOutput(); setPlaying(false); setLoading(false); showView('input'); };

  /* = input view  */
  function updateCount() { const n = $('text').value.length; $('count').textContent = `${n} / ${MAX_CHARS}`; $('count').classList.toggle('over', n > MAX_CHARS); }
  $('text').addEventListener('input', updateCount);
  $('sample').onclick = () => { $('text').value = SAMPLE; $('titleIn').value = SAMPLE_TITLE; $('bookIn').value = ''; updateCount(); };
  $('file').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('text').value = String(r.result); if (!$('titleIn').value) $('titleIn').value = f.name.replace(/\.txt$/i, ''); updateCount(); };
    r.readAsText(f);
  });

  $('gen').onclick = async () => {
    const text = $('text').value.trim();
    $('genErr').textContent = '';
    if (!text) { $('genErr').textContent = 'Paste some text first, or click "Use sample".'; return; }
    $('gen').disabled = true; $('gen').textContent = 'Reading the story & casting voices…';
    try {
      const res = await fetch('/api/segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, book: $('bookIn').value.trim() }) });
      const raw = await res.text(); let data = {};
      try { data = JSON.parse(raw); } catch (_) {}
      if (!res.ok || !data.segments) throw new Error(data.error || `Server replied ${res.status} from ${res.url}: ${raw.slice(0, 200) || '(empty body)'}\nMake sure you opened http://localhost:3000 (not Live Server).`);
      token++; stopOutput();
      segments = data.segments; cast = data.cast; profiles = data.profiles || {}; title = $('titleIn').value.trim() || 'Untitled story';
      durations.length = 0; Object.keys(audioPromises).forEach((k) => delete audioPromises[k]);
      useBrowserVoice = false; idx = 0; finished = false; curMode = null;
      renderCover(title); $('pTitle').textContent = title;
      const names = Object.keys(cast).length;
      $('pSub').textContent = `${names} voices · ${segments.length} lines` + (data.grounded ? ' · cast from the text' + (data.reference ? ' + ' + (data.reference_source || 'web lookup') : '') : ' · basic casting');
      if (data.truncated) toast(`Only the first ${MAX_CHARS} characters were used.`, 6000);
      if (!data.grounded) toast('Character analysis was skipped (no Groq key or it failed), so voices are not matched to age/gender.', 7000);
      buildTicks(); markActive(); updateProgress(); setPlaying(false); setLoading(false); updateEngine();
      showView('player');
    } catch (e) { $('genErr').textContent = e.message; }
    $('gen').disabled = false; $('gen').textContent = 'Create audiobook';
  };

  /* \] UI state  */
  // SVG elements have no .hidden property, so toggle the attribute directly
  const hide = (el, b) => el.toggleAttribute('hidden', !!b);
  function syncPlayIcon() {
    hide($('icoSpin'), !loading);
    hide($('icoPlay'), loading || playing);
    hide($('icoPause'), loading || !playing);
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function setPlaying(p) { playing = p; syncPlayIcon(); }
  function setLoading(l) { loading = l; syncPlayIcon(); }
  function buildTicks() {
    const t = total(); let acc = 0;
    $('ticks').innerHTML = segments.slice(0, -1).map((_, i) => { acc += dur(i); return `<i style="left:${(acc / t) * 100}%"></i>`; }).join('');
  }
  function curFrac() {
    if (finished) return 1;
    if (curMode === 'audio') return player.duration && Number.isFinite(player.duration) ? player.currentTime / player.duration : 0;
    if (curMode === 'speech') return speechFrac;
    return 0;
  }
  function globalPos() { return prefix(idx) + curFrac() * dur(idx); }
  function updateProgress() {
    if (!segments.length) return;
    const t = total(), pos = globalPos();
    if (!dragging) { $('seek').value = (pos / t) * 1000; $('seek').style.setProperty('--p', (pos / t) * 100 + '%'); $('tCur').textContent = fmt(pos); }
    $('tTot').textContent = (allKnown() ? '' : '~') + fmt(t);
  }
  function markActive() {
    const s = segments[idx]; if (!s) return;
    $('chapter').innerHTML = `<b>${esc(s.speaker)}</b> · line ${idx + 1} of ${segments.length}`;
    $('capWho').textContent = s.speaker; $('capLine').textContent = s.text;
    document.querySelectorAll('.tline').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === idx));
    scrollActive();
  }
  function scrollActive() { const a = document.querySelector('.tline.active'); if (a && !panels.cast.hidden) a.scrollIntoView({ block: 'nearest' }); }

  /*  cast panel  */
  async function ensureVoices() {
    if (voicesList) return voicesList;
    try { const r = await fetch('/api/voices'); if (r.ok) voicesList = await r.json(); } catch (_) {}
    return voicesList;
  }
  async function renderCast() {
    const vs = await ensureVoices();
    $('castList').innerHTML = '<h4>Voices</h4>' + Object.entries(cast).map(([name, v]) => {
      const opts = (vs || [v]).map((x) => `<option value="${esc(x.voice_id)}"${x.voice_id === v.voice_id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
      const pr = profiles[name] || {};
      const bits = [pr.label, ...(pr.traits || [])].filter(Boolean).join(' · ');
      const SRC = { text: 'from text', reference: 'from web lookup', knowledge: 'book knowledge, unverified', inferred: 'inferred' };
      const src = [pr.age_source in SRC ? `age ${SRC[pr.age_source]}` : '', pr.gender_source in SRC ? `gender ${SRC[pr.gender_source]}` : ''].filter(Boolean).join(' · ');
      const tip = [pr.evidence && `Text: “${pr.evidence}”`, pr.ref_evidence && `Web source: “${pr.ref_evidence}”`, pr.reason && `Clue: ${pr.reason}`].filter(Boolean).join('\n') || 'No quote or clue found, so this is a best guess';
      return `<div class="castrow"><span title="${esc(tip)}">${esc(name)}<small class="prof">${esc(bits)}</small>${src ? `<small class="prof src">${esc(src)}</small>` : ''}</span><select data-name="${esc(name)}" aria-label="Voice for ${esc(name)}">${opts}</select></div>`;
    }).join('');
    $('transcript').innerHTML = segments.map((s, i) => `<div class="tline${i === idx ? ' active' : ''}" data-i="${i}"><b>${esc(s.speaker)}</b>${esc(s.text)}</div>`).join('');
    scrollActive();
  }
  $('castList').addEventListener('change', (e) => {
    const sel = e.target.closest('select'); if (!sel) return;
    const v = (voicesList || []).find((x) => x.voice_id === sel.value); if (!v) return;
    const name = sel.dataset.name; cast[name] = v;
    segments.forEach((s, i) => { if (s.speaker === name) { delete audioPromises[i]; durations[i] = undefined; } });
    buildTicks(); updateProgress();
    toast(`${name} now uses ${v.name}`, 2500);
  });
  $('transcript').addEventListener('click', (e) => { const l = e.target.closest('.tline'); if (l) startSegment(Number(l.dataset.i)); });
  function updateEngine() {
    $('engineLbl').textContent = useBrowserVoice ? 'Voice engine: browser voices (fallback)' : 'Voice engine: ElevenLabs';
    $('retryEleven').hidden = !useBrowserVoice;
  }
  $('retryEleven').onclick = () => { useBrowserVoice = false; Object.keys(audioPromises).forEach((k) => delete audioPromises[k]); updateEngine(); toast('Will try ElevenLabs on the next line', 2500); };

  /*  audio engine  */
  function loadAudio(i) {
    if (!audioPromises[i]) {
      const s = segments[i], voice = cast[s.speaker] || cast.Narrator;
      audioPromises[i] = fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: s.text, voice_id: voice.voice_id }) })
        .then(async (r) => {
          if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error; } catch (_) {} throw new Error(`TTS ${r.status}: ${m || '(empty body)'}`); }
          return URL.createObjectURL(await r.blob());
        });
      audioPromises[i].catch(() => { delete audioPromises[i]; });
    }
    return audioPromises[i];
  }
  function stopOutput() { player.pause(); try { speechSynthesis.cancel(); } catch (_) {} curMode = null; speechFrac = 0; }

  function switchToBrowser(msg) {
    useBrowserVoice = true; updateEngine();
    toast(`ElevenLabs unavailable (${String(msg).slice(0, 110)}). Using browser voices.`, 7000);
  }

  async function startSegment(i, offset = 0) {
    if (i < 0 || i >= segments.length) return;
    const my = ++token;
    stopOutput(); idx = i; finished = false; markActive(); setPlaying(true);
    let url = null;
    if (!useBrowserVoice) {
      setLoading(true);
      try { url = await loadAudio(i); }
      catch (e) { if (my !== token) return; switchToBrowser(e.message); }
      if (my !== token) return;
      setLoading(false);
    }
    if (useBrowserVoice) { speakSegment(i, my); return; }
    curMode = 'audio'; pendingOffset = offset;
    player.src = url; player.defaultPlaybackRate = rate; player.playbackRate = rate; player.volume = volume;
    player.play().catch(() => { if (my === token) { setPlaying(false); toast('Press play to start audio'); } });
    if (i + 1 < segments.length) loadAudio(i + 1).catch(() => {}); // prefetch next line
  }
  player.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(player.duration)) return;
    durations[idx] = player.duration;
    if (pendingOffset) { player.currentTime = Math.min(pendingOffset, player.duration - 0.05); pendingOffset = 0; }
    buildTicks(); updateProgress();
  });
  player.addEventListener('timeupdate', updateProgress);
  player.addEventListener('ended', () => onSegmentEnd());

  function speakSegment(i, my) {
    const seg = segments[i];
    const all = speechSynthesis.getVoices(), en = all.filter((v) => v.lang && v.lang.startsWith('en')), list = en.length ? en : all;
    const k = Math.max(0, Object.keys(cast).indexOf(seg.speaker));
    const u = new SpeechSynthesisUtterance(seg.text);
    if (list.length) u.voice = list[k % list.length];
    const pr = profiles[seg.speaker] || {};
    if ((pr.gender && pr.gender !== 'unknown') || (pr.age_group && pr.age_group !== 'unknown')) {
      let pitch = pr.gender === 'female' ? 1.2 : pr.gender === 'male' ? 0.85 : 1;   // no real voices to pick from, so shape the pitch by the profile
      if (pr.age_group === 'child') pitch += 0.45; else if (pr.age_group === 'teen') pitch += 0.25; else if (pr.age_group === 'old') pitch -= 0.15;
      u.pitch = Math.min(2, Math.max(0.1, pitch));
    } else u.pitch = seg.speaker === 'Narrator' ? 0.9 : 0.8 + ((k * 0.25) % 0.9);
    u.rate = rate; u.volume = volume;
    u.onboundary = (e) => { if (my === token) { speechFrac = Math.min(1, e.charIndex / seg.text.length); updateProgress(); } };
    u.onend = u.onerror = () => { if (my === token) onSegmentEnd(); };
    curMode = 'speech'; speechFrac = 0;
    setTimeout(() => { if (my === token) speechSynthesis.speak(u); }, 60); // Chrome drops speak() straight after cancel()
  }

  function onSegmentEnd() {
    curMode = null; speechFrac = 0;
    if (idx + 1 >= segments.length) { finished = true; setPlaying(false); updateProgress(); return; }
    if (settings.autoplay) startSegment(idx + 1);
    else { idx++; markActive(); setPlaying(false); updateProgress(); }
  }

  function togglePlay() {
    if (!segments.length) return;
    if (loading) { token++; setLoading(false); setPlaying(false); return; }
    if (playing) { if (curMode === 'audio') player.pause(); else if (curMode === 'speech') speechSynthesis.pause(); setPlaying(false); return; }
    if (finished) { startSegment(0); return; }
    if (curMode === 'audio') { player.play(); setPlaying(true); }
    else if (curMode === 'speech') { speechSynthesis.resume(); setPlaying(true); }
    else startSegment(idx);
  }

  function seekGlobal(t) {
    const T = total(); t = Math.max(0, Math.min(t, T - 0.05)); let acc = 0;
    for (let j = 0; j < segments.length; j++) {
      const d = dur(j);
      if (t < acc + d || j === segments.length - 1) {
        const off = t - acc;
        if (j === idx && curMode === 'audio') { player.currentTime = Math.min(off, (player.duration || d) - 0.05); updateProgress(); }
        else startSegment(j, off);
        return;
      }
      acc += d;
    }
  }

  /*  controls  */
  $('playBtn').onclick = togglePlay;
  $('backSkip').onclick = () => segments.length && seekGlobal(globalPos() - settings.back);
  $('fwdSkip').onclick = () => segments.length && seekGlobal(globalPos() + settings.fwd);
  $('nextBtn').onclick = () => { if (idx + 1 < segments.length) startSegment(idx + 1); };
  $('prevBtn').onclick = () => { if (curFrac() * dur(idx) > 3 || idx === 0) startSegment(idx); else startSegment(idx - 1); };
  $('seek').addEventListener('input', () => {
    dragging = true; const t = ($('seek').value / 1000) * total();
    $('seek').style.setProperty('--p', $('seek').value / 10 + '%'); $('tCur').textContent = fmt(t);
  });
  $('seek').addEventListener('change', () => { dragging = false; seekGlobal(($('seek').value / 1000) * total()); });
  document.addEventListener('keydown', (e) => {
    if ($('playerView').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') $('backSkip').click();
    else if (e.code === 'ArrowRight') $('fwdSkip').click();
  });
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};

  /* ---------- init ---------- */
  applySettings(); updateCount(); showView('input');
  fetch('/api/config').then((r) => r.json()).then((c) => { if (c.max_chars) { MAX_CHARS = c.max_chars; updateCount(); } }).catch(() => {});
})();