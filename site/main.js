(() => {
  // Mirrors the preset table in README.md (Opus / Haiku tier models).
  const PRESETS = [
    { id: 'kimi', name: 'KIMI', url: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3[1m]', fast: 'kimi-k2.7-code' },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash[1m]', fast: 'deepseek-flash' },
    { id: 'glm', name: 'GLM', url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3[1m]', fast: 'glm-5.3-flash' },
    { id: 'qwen', name: 'Bailian', url: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.7-max', fast: 'qwen3.6-flash' },
    { id: 'minimax', name: 'MiniMax', url: 'https://api.minimax.cn/anthropic', model: 'MiniMax-M3.1-Flash[1m]', fast: 'MiniMax-M3.1-Flash[1m]' },
    { id: 'mimo', name: 'MiMo', url: 'https://api.xiaomimimo.com/anthropic', model: 'mimo-v2.6-pro', fast: 'mimo-v2.6-pro' },
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api', model: '~anthropic/claude-opus-latest[1m]', fast: '~anthropic/claude-haiku-latest' },
    { id: 'ollama', name: 'Ollama', url: 'http://localhost:11434', model: 'gemma4:31b', fast: 'gemma4:e4b' },
  ];
  const UI = {
    zh: { copied: '已复制', switched: '已切换到', launch: '以 dev 模式启动 Claude Code', running: '运行中', done: '已完成', queued: '排队中', title: 'CCEM — 编排每一个模型' },
    en: { copied: 'Copied', switched: 'Switched to', launch: 'launch Claude Code in dev mode', running: 'Running', done: 'Done', queued: 'Queued', title: 'CCEM — Orchestrate every model.' },
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let lang = localStorage.getItem('ccem-lang') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  let preset = PRESETS[0];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  // ---- i18n: Chinese lives in the markup, English in data-en.
  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-en]').forEach((el) => {
      if (el.dataset.zh === undefined) el.dataset.zh = el.innerHTML;
      el.innerHTML = lang === 'en' ? el.dataset.en : el.dataset.zh;
    });
    $('.lang-toggle').textContent = lang === 'zh' ? 'EN' : '中文';
    document.title = UI[lang].title;
    renderTerminal(false);
    if (handoffStarted) handoff.querySelectorAll('.status').forEach((el) => { el.textContent = UI[lang][el.dataset.s]; });
  }
  $('.lang-toggle').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('ccem-lang', lang);
    applyLang();
  });

  // ---- Theme: html[data-theme] is set before paint in <head>; scene.js observes it.
  const themeMeta = $('meta[name="theme-color"]');
  const syncThemeMeta = () => themeMeta.setAttribute('content', document.documentElement.dataset.theme === 'light' ? '#ffffff' : '#050507');
  $('.theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ccem-theme', next);
    syncThemeMeta();
  });
  syncThemeMeta();

  // ---- Copy buttons
  const toast = $('.toast');
  let toastTimer;
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); } catch { return; }
      toast.textContent = `${UI[lang].copied} · ${btn.dataset.copy}`;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
    });
  });

  // ---- Provider switcher
  const chips = $('.chips');
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.textContent = p.name;
    b.addEventListener('click', () => { preset = p; renderTerminal(true); });
    chips.appendChild(b);
  });
  const term = $('.terminal-body');
  let typeTimers = [];
  function renderTerminal(animate) {
    chips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-selected', String(PRESETS[i] === preset)));
    const p = preset;
    const lines = [
      `<span class="t-dim">$</span> ccem use ${p.id}`,
      `<span class="t-ok">✓</span> ${UI[lang].switched} <b>${p.id}</b>`,
      `  <span class="t-key">ANTHROPIC_BASE_URL</span>=${esc(p.url)}`,
      `  <span class="t-key">ANTHROPIC_DEFAULT_OPUS_MODEL</span>=${esc(p.model)}`,
      `  <span class="t-key">ANTHROPIC_DEFAULT_HAIKU_MODEL</span>=${esc(p.fast)}`,
      `<span class="t-dim">$</span> ccem dev   <span class="t-dim"># ${UI[lang].launch}</span>`,
    ];
    typeTimers.forEach(clearTimeout);
    typeTimers = [];
    term.innerHTML = '';
    lines.forEach((html, i) => {
      const add = () => {
        const span = document.createElement('span');
        span.className = 'line';
        span.innerHTML = html + (i === lines.length - 1 ? ' <span class="caret"></span>' : '');
        term.appendChild(span);
      };
      if (animate) typeTimers.push(setTimeout(add, i * 120)); else add();
    });
  }

  // ---- Delegation demo: queued → running → done, staggered.
  const handoff = $('.handoff');
  let handoffStarted = false;
  function runHandoff() {
    handoffStarted = true;
    const set = (el, s) => { el.dataset.s = s; el.className = `status ${s}`; el.textContent = UI[lang][s]; };
    handoff.querySelectorAll('.status').forEach((el, i) => {
      set(el, 'queued');
      setTimeout(() => set(el, 'running'), 700 + i * 320);
      setTimeout(() => set(el, 'done'), 2200 + i * 650);
    });
  }

  // ---- Scroll reveal
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      if (e.target === handoff && !handoffStarted) runHandoff();
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  // ---- Story stage: scroll progress → active chapter. scene.js reads window.ccemStory.
  const stage = $('.stage');
  const chapters = [...document.querySelectorAll('.chapter')];
  const dots = [...document.querySelectorAll('.stage-dots button')];
  const story = (window.ccemStory = { progress: 0, active: -1 });
  const last = chapters.length - 1;
  function readStory() {
    const rect = stage.getBoundingClientRect();
    const p = Math.min(Math.max(-rect.top / (rect.height - innerHeight), 0), 1);
    story.progress = p * last;
    const idx = Math.round(story.progress);
    if (idx === story.active) return;
    story.active = idx;
    chapters.forEach((c, i) => c.classList.toggle('active', i === idx));
    dots.forEach((d, i) => d.setAttribute('aria-current', String(i === idx)));
    stage.dataset.chapter = idx;
  }
  addEventListener('scroll', readStory, { passive: true });
  addEventListener('resize', readStory);
  dots.forEach((d, i) => d.addEventListener('click', () => {
    scrollTo({ top: stage.offsetTop + ((stage.offsetHeight - innerHeight) * i) / last, behavior: reduceMotion ? 'auto' : 'smooth' });
  }));
  readStory();

  // ---- Scroll-linked 3D tilt: screenshots lie back and stand up as they reach mid-screen.
  const tilts = [...document.querySelectorAll('.tilt')];
  let ticking = false;
  function updateTilts() {
    ticking = false;
    const vh = innerHeight;
    tilts.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const t = Math.min(Math.max((vh - r.top) / (vh * 0.85), 0), 1); // 0 entering → 1 settled
      const side = el.closest('.tilt-side') ? -1 : 0;
      el.style.setProperty('--rx', `${((1 - t) * 26).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(side * (1 - t) * 18).toFixed(2)}deg`);
      el.style.setProperty('--tz', `${((1 - t) * -160).toFixed(1)}px`);
    });
  }
  if (!reduceMotion) {
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateTilts); } }, { passive: true });
    updateTilts();
  }

  applyLang();
})();
