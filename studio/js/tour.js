/* SesTemiz · site turu
   driver.js mantığı: hedef öğenin etrafında yuvarlak köşeli bir spot ışığı, geri kalan her şey karartılır,
   yanında oku hedefe dönük cam bir açıklama kutusu. Adımlar sayfalar arasında gezer; kutu ve spot adımlar
   arasında süzülür. Klavye: → / Enter ileri, ← geri, Esc kapat. İlk ziyarette ana sayfada kendiliğinden açılır. */
(() => {
  "use strict";
  const S = window.SesTemiz;
  if (!S) return;
  const $ = (s, r = document) => r.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const PAD = 10, GAP = 16, EDGE = 12;
  const SEEN_KEY = "st-tour";

  // Her adım: gidilecek sayfa, hedef (ilk görünür olan seçilir) ve tercih edilen kenar. Hedefsiz adım ortada açılır.
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // dar ekranda kapalı açılır menü gibi saydam/gizli öğeleri atla
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  const pick = (...sels) => () => sels.map((s) => (typeof s === "function" ? s() : $(s))).find(visible) || null;
  const STEPS = [
    { id: "welcome", route: "", el: pick(".hero-copy .display", ".hero-copy"), side: "bottom" },
    { id: "hero", route: "", el: pick(".hero-visual"), side: "left" },
    { id: "nav", route: "", el: pick("#nav", "#menuBtn"), side: "bottom" },
    { id: "tools", route: "", el: pick(".tools"), side: "bottom" },
    { id: "input", route: "studio", el: pick(() => $("#drop")?.closest(".panel"), () => $("#inputLoaded")?.closest(".panel")), side: "right" },
    { id: "models", route: "studio", el: pick(() => $("#models")?.closest(".panel")), side: "right" },
    { id: "run", route: "studio", el: pick("#runBtn"), side: "top" },
    { id: "output", route: "studio", el: pick(".studio-main"), side: "left" },
    { id: "samples", route: "samples", el: pick("#trGrid .scard", "#sampleGrid .scard"), side: "right" },
    { id: "real", route: "samples", el: pick("#realGrid .scard", "#realSection .sec-head"), side: "right" },
    { id: "results", route: "results", el: pick(() => $("#bars")?.closest(".chart-card")), side: "top" },
    { id: "method", route: "method", el: pick(".pipeline"), side: "bottom" },
    { id: "done", route: null, el: null },
  ];

  let root, spot, pop, arrow, els, idx = -1, active = false, busy = false, raf = 0, target = null, lastRect = null;

  function build() {
    root = document.createElement("div");
    root.className = "tour";
    root.innerHTML = `
      <div class="tour-veil"></div>
      <div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText" tabindex="-1">
        <span class="tour-arrow" aria-hidden="true"></span>
        <div class="tour-head">
          <span class="tour-count mono"></span>
          <button type="button" class="tour-x" data-act="close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>
        </div>
        <div class="tour-body" aria-live="polite">
          <p class="tour-kicker mono"></p>
          <h3 class="tour-title" id="tourTitle"></h3>
          <p class="tour-text" id="tourText"></p>
        </div>
        <div class="tour-bar"><i></i></div>
        <div class="tour-foot">
          <button type="button" class="tour-skip" data-act="close"></button>
          <span class="tour-fill"></span>
          <button type="button" class="tour-btn" data-act="prev"></button>
          <button type="button" class="tour-btn primary" data-act="next"><span></span><i aria-hidden="true">→</i></button>
        </div>
      </div>`;
    document.body.append(root);
    spot = $(".tour-spot", root);
    pop = $(".tour-pop", root);
    arrow = $(".tour-arrow", root);
    els = {
      count: $(".tour-count", root), kicker: $(".tour-kicker", root), title: $(".tour-title", root), text: $(".tour-text", root),
      bar: $(".tour-bar i", root), skip: $(".tour-skip", root), prev: $('[data-act="prev"]', root), next: $('[data-act="next"] span', root),
      nextBtn: $('[data-act="next"]', root), x: $(".tour-x", root),
    };
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "next") next();
      else if (act === "prev") go(idx - 1);
      else if (act === "close") close();
      else if (e.target.classList.contains("tour-veil")) nudge();
    });
  }

  // ---- metinler (dil değişince yeniden yazılır)
  function fillText(animate) {
    const st = STEPS[idx], t = S.t;
    els.count.textContent = `${String(idx + 1).padStart(2, "0")} / ${String(STEPS.length).padStart(2, "0")}`;
    els.kicker.textContent = t(`tour.${st.id}.k`);
    els.title.textContent = t(`tour.${st.id}.t`);
    els.text.innerHTML = t(`tour.${st.id}.d`);
    els.skip.textContent = t("tour.skip");
    els.skip.hidden = idx === STEPS.length - 1;
    els.prev.textContent = t("tour.prev");
    els.prev.hidden = idx === 0;
    els.next.textContent = idx === STEPS.length - 1 ? t("tour.finish") : idx === 0 ? t("tour.start") : t("tour.next");
    els.x.setAttribute("aria-label", t("tour.close"));
    els.bar.style.transform = `scaleX(${(idx + 1) / STEPS.length})`;
    if (animate && !S.reduced) {
      const body = $(".tour-body", root);
      body.classList.remove("swap"); void body.offsetWidth; body.classList.add("swap");
    }
  }

  // ---- konumlama
  const HEAD = 84; // yapışkan üst çubuk
  const padded = (b) => ({ left: b.left - PAD, top: b.top - PAD, right: b.right + PAD, bottom: b.bottom + PAD, width: b.width + PAD * 2, height: b.height + PAD * 2 });
  function chooseSide(r, pw, ph, preferred) {
    const vw = innerWidth, vh = innerHeight;
    const fits = {
      bottom: r.bottom + GAP + ph <= vh - EDGE, top: r.top - GAP - ph >= HEAD,
      right: r.right + GAP + pw <= vw - EDGE, left: r.left - GAP - pw >= EDGE,
    };
    return [preferred || "bottom", "bottom", "top", "right", "left"].find((s) => fits[s]) || "dock";
  }

  function place() {
    const vw = innerWidth, vh = innerHeight;
    if (!target || !target.isConnected) {
      // hedefsiz adım: spot ekranın ortasında küçülerek kaybolur, kutu ortada durur
      spot.classList.add("none");
      Object.assign(spot.style, { transform: `translate(${vw / 2}px, ${vh / 2}px)`, width: "0px", height: "0px" });
      pop.dataset.side = "center";
      pop.style.transform = `translate(${Math.round((vw - pop.offsetWidth) / 2)}px, ${Math.round((vh - pop.offsetHeight) / 2)}px)`;
      return;
    }
    spot.classList.remove("none");
    const b = target.getBoundingClientRect();
    const r = { left: b.left - PAD, top: b.top - PAD, width: b.width + PAD * 2, height: b.height + PAD * 2 };
    r.right = r.left + r.width; r.bottom = r.top + r.height;
    const key = `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0},${vw},${vh}`;
    if (key === lastRect) return;
    lastRect = key;
    const radius = parseFloat(getComputedStyle(target).borderRadius) || 0;
    Object.assign(spot.style, {
      transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px`,
      borderRadius: `${Math.max(12, radius + PAD * 0.6)}px`,
    });

    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const side = chooseSide(r, pw, ph, STEPS[idx].side);
    const clampX = (x) => Math.min(Math.max(x, EDGE), vw - pw - EDGE);
    const clampY = (y) => Math.min(Math.max(y, EDGE), vh - ph - EDGE);
    let x, y;
    if (side === "bottom" || side === "top") {
      x = clampX(r.left + r.width / 2 - pw / 2);
      y = side === "bottom" ? r.bottom + GAP : r.top - GAP - ph;
    } else if (side === "right" || side === "left") {
      x = side === "right" ? r.right + GAP : r.left - GAP - pw;
      y = clampY(r.top + r.height / 2 - ph / 2);
    } else {
      // hedef ekranı kaplıyor (mobilde büyük kartlar): kutu ekranın altına yaslanır, ok gizlenir
      x = clampX((vw - pw) / 2); y = vh - ph - EDGE;
    }
    pop.dataset.side = side;
    pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (side === "bottom" || side === "top") {
      const ax = Math.min(Math.max(r.left + r.width / 2 - x, 22), pw - 22);
      arrow.style.left = `${ax}px`; arrow.style.top = "";
    } else if (side !== "dock") {
      const ay = Math.min(Math.max(r.top + r.height / 2 - y, 22), ph - 22);
      arrow.style.top = `${ay}px`; arrow.style.left = "";
    }
  }
  const loop = () => { place(); raf = requestAnimationFrame(loop); };

  // ---- hedefi bekle: sayfa geçişi bitsin, öğe görünür olsun
  async function findTarget(st, token) {
    if (st.route !== null && S.route() !== st.route) location.hash = `#/${st.route}`;
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      if (token !== goToken) return undefined;
      if (st.route === null || (S.route() === st.route && S.settled())) {
        const el = st.el ? st.el() : null;
        if (!st.el || el) return el;
      }
      await wait(60);
    }
    return st.el ? st.el() : null;
  }
  // Hedefi, açıklama kutusunun da sığacağı biçimde görünür yap. Kutu yanlara sığmıyorsa hedef üst çubuğun
  // hemen altına kaydırılır, kutu altına yerleşir; hedef ekrandan uzunsa kutu en alta yaslanır.
  async function bringIntoView(el, step) {
    if (!el) return;
    const b = el.getBoundingClientRect(), vh = innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const fully = b.top >= HEAD && b.bottom <= vh - EDGE;
    if (fully && chooseSide(padded(b), pw, ph, step.side) !== "dock") return;
    const sideFits = chooseSide({ ...padded(b), top: HEAD + PAD, bottom: HEAD + PAD + b.height }, pw, ph, step.side);
    const top = sideFits === "right" || sideFits === "left"
      ? b.top + scrollY - Math.max(HEAD + PAD, (vh - b.height) / 2) // yanlara sığıyorsa ortala
      : b.top + scrollY - HEAD - PAD - 6;                           // değilse üste al, kutu altta
    if (Math.abs(top - scrollY) < 2) return;
    scrollTo({ top: Math.max(0, top), behavior: S.reduced ? "auto" : "smooth" });
    // kaydırma bitene kadar bekle (konum art arda 4 kare değişmeyince)
    let last = -1, still = 0;
    for (let i = 0; i < 90 && still < 4; i++) { await frame(); if (scrollY === last) still++; else { still = 0; last = scrollY; } }
  }

  let goToken = 0;
  async function go(i) {
    if (i < 0 || i >= STEPS.length || busy && i === idx) return;
    const token = ++goToken;
    busy = true;
    const first = idx === -1, st = STEPS[i], pageChange = st.route !== null && S.route() !== st.route;
    root.classList.add("moving");
    if (pageChange) root.classList.add("travel");
    const el = await findTarget(st, token);
    if (token !== goToken) return;
    idx = i;
    fillText(!first); // önce metin: kutunun yeni yüksekliği kaydırma hesabına girsin
    await bringIntoView(el, st);
    if (token !== goToken) return;
    target = el; lastRect = null;
    await frame();
    place();
    root.classList.remove("moving", "travel");
    if (first) root.classList.add("on");
    busy = false;
    els.nextBtn.focus({ preventScroll: true });
  }
  function next() {
    if (idx === STEPS.length - 1) { close(); location.hash = "#/studio"; return; }
    go(idx + 1);
  }
  function nudge() {
    if (S.reduced) return;
    pop.classList.remove("nudge"); void pop.offsetWidth; pop.classList.add("nudge");
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight" || (e.key === "Enter" && !e.target.closest?.(".tour-x, .tour-skip, [data-act=prev]"))) { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    else if (e.key === "Tab") {
      // odak kutunun içinde kalsın
      const f = [...pop.querySelectorAll("button:not([hidden])")];
      const at = f.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  const langObserver = new MutationObserver(() => active && idx >= 0 && (fillText(true), (lastRect = null)));

  function start(from = 0) {
    if (active) return;
    if (!root) build();
    active = true; idx = -1; target = null; lastRect = null;
    root.classList.remove("closing", "on");
    root.hidden = false;
    document.documentElement.classList.add("touring");
    addEventListener("keydown", onKey, true);
    langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    raf = requestAnimationFrame(loop);
    go(from);
  }
  function close() {
    if (!active) return;
    active = false; goToken++; busy = false;
    S.store.set(SEEN_KEY, "1");
    removeEventListener("keydown", onKey, true);
    langObserver.disconnect();
    root.classList.add("closing");
    root.classList.remove("on");
    document.documentElement.classList.remove("touring");
    const done = () => { cancelAnimationFrame(raf); root.hidden = true; root.classList.remove("closing"); };
    if (S.reduced) done(); else setTimeout(done, 420);
    document.getElementById("tourBtn")?.focus({ preventScroll: true });
  }

  document.getElementById("tourBtn")?.addEventListener("click", () => start(0));
  window.SesTour = { start, close };

  // ilk ziyaret: ana sayfadaysa açılış animasyonundan sonra kendiliğinden başlar
  if (S.store.get(SEEN_KEY) !== "1") {
    S.ready.then(() => wait(1100)).then(() => { if (!active && S.route() === "" && S.store.get(SEEN_KEY) !== "1") start(0); });
  }
})();
