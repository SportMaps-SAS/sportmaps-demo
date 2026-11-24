// Chequeos que corren DENTRO de la página (page.evaluate). Una sola función
// autocontenida: no puede cerrar sobre nada de Node.
//
// Devuelve hallazgos crudos; la clasificación pass/warn/fail la hace run.mjs
// (classify) para poder recalibrar umbrales sin recapturar.

export async function inPageChecks(opts) {
  const { mobileMax = 767, maxSamples = 12 } = opts || {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const isMobile = vw <= mobileMax;
  const doc = document.documentElement;

  // ── utilidades ───────────────────────────────────────────────────────────
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const shortCls = (el) => {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c.trim().split(/\s+/).filter((x) => x && !x.includes(':') && !x.includes('[')).slice(0, 2);
  };
  const selPath = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6 && n !== document.body) {
      let p = n.tagName.toLowerCase();
      if (n.id && !/^radix-|^:r/.test(n.id)) { parts.unshift(`${p}#${cssEsc(n.id)}`); break; }
      const tid = n.getAttribute('data-testid');
      if (tid) { parts.unshift(`${p}[data-testid="${tid}"]`); break; }
      const cls = shortCls(n);
      if (cls.length) p += '.' + cls.map(cssEsc).join('.');
      const par = n.parentElement;
      if (par) {
        const same = [...par.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const fullCls = (el) => (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '').trim();
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const isVisible = (el, r) => {
    r = r || el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  };
  // región del layout: los hallazgos en sidebar/header/barra inferior son del
  // layout global, no de la página (el mapeo a fuente lo usa)
  const regionOf = (el) => el.closest('[data-sidebar]') ? 'sidebar' : el.closest('[data-testid="mobile-bottom-nav"]') ? 'bottomnav' : el.closest('header') && !el.closest('main') ? 'header' : el.closest('[role="dialog"],[role="alertdialog"]') ? 'dialog' : el.closest('main') ? 'main' : 'otro';
  const sample = (el, extra) => ({ sel: selPath(el), cls: fullCls(el).slice(0, 300), tag: el.tagName.toLowerCase(), text: text(el), region: regionOf(el), ...extra });
  const all = [...document.body.querySelectorAll('*')];
  const inClosedSidebar = (el) => {
    // sidebar off-canvas de shadcn en móvil o colapsado: no cuenta.
    const sb = el.closest('[data-sidebar="sidebar"], [data-sidebar]');
    if (!sb) return false;
    const r = sb.getBoundingClientRect();
    return r.right <= 0 || r.left >= vw;
  };
  const clippedByAncestor = (el) => {
    // ¿algún ancestro recorta en X (overflow hidden/auto/scroll/clip)? Entonces
    // el desborde no genera scroll de página (es scroll interno o recorte).
    let p = el.parentElement;
    while (p && p !== document.body && p !== doc) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') return p;
      p = p.parentElement;
    }
    return null;
  };

  // El layout de la app hace scroll dentro de <main> (el documento mide lo que
  // la ventana). "Scroller principal" = el documento si desplaza; si no, el
  // contenedor con scroll vertical más grande que cubra ≥50 % de la ventana.
  const findPrimaryScroller = () => {
    if (doc.scrollHeight > vh + 1) return doc;
    let best = null, bestA = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      if (el.closest('[data-sidebar], [role="dialog"]')) continue;
      const r = el.getBoundingClientRect();
      // área VISIBLE (recortada a la ventana): una tabla de 5000px de alto no gana a <main>
      const a = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (el.scrollHeight - el.clientHeight <= 8) continue;
      if (r.height >= vh * 0.5 && a > bestA) { best = el; bestA = a; }
    }
    return best;
  };
  const primary = findPrimaryScroller();
  const fixedLayer = (el) => { let p = el; while (p && p !== doc) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return p; p = p.parentElement; } return null; };
  const isSrOnly = (el) => { const r = el.getBoundingClientRect(); return r.width <= 2 || r.height <= 2 || /sr-only/.test(fullCls(el)) || getComputedStyle(el).clip.startsWith('rect(0'); };

  const out = { vw, vh, dpr, isMobile, url: location.pathname + location.search,
    primaryScroller: primary ? (primary === doc ? 'document' : selPath(primary)) : 'ninguno' };

  // ── 1. desborde horizontal ───────────────────────────────────────────────
  // Cuenta el del documento Y el del scroller principal (<main> con
  // overflow-y:auto fuerza overflow-x:auto: el desborde se vuelve scroll
  // horizontal de toda la pantalla aunque el documento no lo tenga).
  const scrollW = Math.max(doc.scrollWidth, document.body.scrollWidth);
  const mainOv = primary && primary !== doc ? Math.max(0, primary.scrollWidth - primary.clientWidth) : 0;
  out.overflow = { scrollWidth: scrollW, docOverflowPx: Math.max(0, scrollW - vw), mainOverflowPx: mainOv, offenders: [] };
  out.overflow.overflowPx = Math.max(out.overflow.docOverflowPx, mainOv);
  {
    const limitFor = (clip) => (clip ? Math.min(clip.getBoundingClientRect().right, vw) : vw);
    const offending = new Set();
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r) || inClosedSidebar(el)) continue;
      if (r.right <= Math.min(vw, primary && primary !== doc ? primary.getBoundingClientRect().right : vw) + 1) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' && r.left >= vw) continue; // drawers fuera de pantalla
      const clip = clippedByAncestor(el);
      // recorte legítimo: un ancestro que NO es el scroller principal (tabla con
      // overflow-x-auto, carrusel, etc.). Si el que recorta es el principal → cuenta.
      if (clip && clip !== primary) continue;
      if (r.right <= limitFor(clip) + 1) continue;
      offending.add(el);
    }
    const roots = [...offending].filter((el) => !offending.has(el.parentElement));
    out.overflow.offenderCount = offending.size;
    out.overflow.offenders = roots.slice(0, maxSamples).map((el) => {
      const r = el.getBoundingClientRect();
      return sample(el, { right: Math.round(r.right), width: Math.round(r.width) });
    });
  }

  // ── 2. objetivos táctiles < 44×44 (móvil) ────────────────────────────────
  out.touch = { count: 0, samples: [] };
  out.textSmall = { count: 0, samples: [] };
  out.inputZoom = { count: 0, samples: [] };
  const interactive = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="switch"]')];
  if (isMobile) {
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r) || inClosedSidebar(el)) continue;
      if (r.bottom < 0 || r.right < 0 || r.left > vw) continue;
      // links dentro de un párrafo de texto: excepción WCAG 2.5.8 (inline)
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p, li')) continue;
      if (r.width < 44 || r.height < 44) {
        out.touch.count++;
        if (out.touch.samples.length < maxSamples) out.touch.samples.push(sample(el, { w: Math.round(r.width), h: Math.round(r.height) }));
      }
    }
    for (const el of document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]), textarea, select')) {
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) {
        out.inputZoom.count++;
        if (out.inputZoom.samples.length < maxSamples) out.inputZoom.samples.push(sample(el, { fontSize: fs }));
      }
    }
  }

  // ── 3. texto < 12px ──────────────────────────────────────────────────────
  for (const el of all) {
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasOwnText) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r) || inClosedSidebar(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) {
      out.textSmall.count++;
      if (out.textSmall.samples.length < maxSamples) out.textSmall.samples.push(sample(el, { fontSize: fs }));
    }
  }

  // ── 4. bottom nav: fijos encima / contenido tapado al final ──────────────
  out.bottomNav = { present: false, overlapFixed: [], hiddenAtEnd: [] };
  const nav = document.querySelector('[data-testid="mobile-bottom-nav"]');
  if (nav && isVisible(nav)) {
    out.bottomNav.present = true;
    const nr = nav.getBoundingClientRect();
    out.bottomNav.height = Math.round(nr.height);
    const inter = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const el of all) {
      if (nav.contains(el) || el.contains(nav)) continue;
      const cs = getComputedStyle(el);
      // sticky solo cuenta si se pega ABAJO (bottom fijado); un sticky top-* en flujo es contenido normal
      if (cs.position !== 'fixed' && !(cs.position === 'sticky' && cs.bottom !== 'auto')) continue;
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) continue;
      if (r.height >= vh * 0.9 && r.width >= vw * 0.9) continue; // overlays de pantalla completa
      if (!(el.innerText || '').trim() && !el.querySelector('img,svg,video,canvas')) continue; // contenedores vacíos (toaster sin toasts)
      if (inter(r, nr)) out.bottomNav.overlapFixed.push(sample(el, { top: Math.round(r.top), bottom: Math.round(r.bottom), z: cs.zIndex }));
    }
    out.bottomNav.overlapFixed = out.bottomNav.overlapFixed.slice(0, maxSamples);
    // al final de la página: ¿queda contenido interactivo/texto bajo la barra?
    const scroller = primary === doc || !primary ? null : primary;
    const prevY = scroller ? scroller.scrollTop : window.scrollY;
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' }); else window.scrollTo({ top: doc.scrollHeight, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 250));
    const nr2 = nav.getBoundingClientRect();
    const leafs = [...document.querySelectorAll('main button, main a[href], main input, main [role="button"], main h1, main h2, main h3, main p, main td, main span, main label')];
    for (const el of leafs) {
      if (nav.contains(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) continue;
      if (el.children.length > 2) continue;
      if (r.bottom > nr2.top + 2 && r.top < nr2.bottom) {
        // ¿realmente está debajo? elemento en el punto medio visible de su franja
        const y = Math.min(r.bottom - 1, nr2.top + 4);
        const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
        const top = document.elementFromPoint(x, y);
        if (top && nav.contains(top)) out.bottomNav.hiddenAtEnd.push(sample(el, { top: Math.round(r.top), bottom: Math.round(r.bottom), navTop: Math.round(nr2.top) }));
      }
      if (out.bottomNav.hiddenAtEnd.length >= maxSamples) break;
    }
    if (scroller) scroller.scrollTo({ top: prevY, behavior: 'instant' }); else window.scrollTo({ top: prevY, behavior: 'instant' });
  }

  // ── 5. imágenes pixeladas ────────────────────────────────────────────────
  out.images = { checked: 0, pixelated: [] };
  const isVector = (u) => /\.svg(\?|#|$)/i.test(u) || /^data:image\/svg/i.test(u);
  const renderScale = (fit, rw, rh, nw, nh) => {
    if (fit === 'contain' || fit === 'scale-down') return Math.min(rw / nw, rh / nh);
    if (fit === 'cover') return Math.max(rw / nw, rh / nh);
    if (fit === 'none') return 1;
    return Math.max(rw / nw, rh / nh); // fill
  };
  const tagImg = (u, el) => {
    const s = (u + ' ' + (el.getAttribute && (el.getAttribute('alt') || '')) + ' ' + fullCls(el)).toLowerCase();
    if (/logo|brand|isotipo|escudo/.test(s)) return 'logo';
    if (/unsplash|banner|cover|hero|portada/.test(s)) return 'banner';
    if (/avatar|profile|foto|photo|rounded-full/.test(s)) return 'avatar';
    if (/icon|pwa|favicon/.test(s)) return 'icono';
    if (/banner|cover|hero|portada/.test(s)) return 'banner';
    if (/card|carnet/.test(s)) return 'carnet';
    return 'imagen';
  };
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    if (!isVisible(img, r) || !img.complete || !img.naturalWidth) continue;
    const u = img.currentSrc || img.src;
    if (isVector(u)) continue;
    out.images.checked++;
    const fit = getComputedStyle(img).objectFit;
    const sc = renderScale(fit, r.width, r.height, img.naturalWidth, img.naturalHeight);
    const need = sc * dpr;
    if (need > 1.1) {
      out.images.pixelated.push(sample(img, {
        src: u.slice(0, 200), kind: tagImg(u, img), natural: `${img.naturalWidth}×${img.naturalHeight}`,
        rendered: `${Math.round(r.width)}×${Math.round(r.height)}`, required: `${Math.ceil(r.width * dpr)}×${Math.ceil(r.height * dpr)}`,
        upscale: Math.round(need * 100) / 100,
      }));
    }
  }
  const bgEls = all.filter((el) => { const b = getComputedStyle(el).backgroundImage; return b && b.includes('url('); });
  await Promise.all(bgEls.slice(0, 40).map(async (el) => {
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) return;
    const cs = getComputedStyle(el);
    const m = cs.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
    if (!m || isVector(m[1])) return;
    const im = new Image();
    im.src = m[1];
    try { await Promise.race([im.decode(), new Promise((_, rej) => setTimeout(rej, 3000))]); } catch { return; }
    if (!im.naturalWidth) return;
    out.images.checked++;
    const size = cs.backgroundSize;
    let sc;
    if (size === 'cover') sc = Math.max(r.width / im.naturalWidth, r.height / im.naturalHeight);
    else if (size === 'contain') sc = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight);
    else if (size.includes('px')) sc = parseFloat(size) / im.naturalWidth;
    else if (size.includes('%')) sc = (parseFloat(size) / 100) * r.width / im.naturalWidth;
    else sc = 1;
    if (sc * dpr > 1.1) out.images.pixelated.push(sample(el, {
      src: m[1].slice(0, 200), kind: tagImg(m[1], el), background: true, natural: `${im.naturalWidth}×${im.naturalHeight}`,
      rendered: `${Math.round(r.width)}×${Math.round(r.height)}`, required: `${Math.ceil(im.naturalWidth * sc * dpr)}×${Math.ceil(im.naturalHeight * sc * dpr)}`,
      upscale: Math.round(sc * dpr * 100) / 100,
    }));
  }));
  out.images.pixelated = out.images.pixelated.slice(0, maxSamples * 2);

  // ── 6. texto borroso: transform/filter/zoom + fuentes ────────────────────
  out.blur = { count: 0, samples: [] };
  for (const el of all) {
    const cs = getComputedStyle(el);
    const reasons = [];
    if (cs.transform && cs.transform !== 'none') {
      const m = cs.transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        const [a, b, c, d, e, f] = m[1].split(',').map(Number);
        const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
        if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) reasons.push(`scale(${sx.toFixed(2)})`);
        const fx = (e * dpr) % 1, fy = (f * dpr) % 1;
        const frac = (v) => Math.min(Math.abs(v), 1 - Math.abs(v)) > 0.05;
        if (frac(fx) || frac(fy)) reasons.push(`translate subpíxel (${e.toFixed(2)},${f.toFixed(2)})`);
      } else if (cs.transform.startsWith('matrix3d')) reasons.push('matrix3d');
    }
    if (cs.filter && /blur/.test(cs.filter)) reasons.push(`filter:${cs.filter}`);
    if (cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') reasons.push(`zoom:${cs.zoom}`);
    if (!reasons.length) continue;
    // solo cuenta si contiene texto visible y no es animación de entrada transitoria
    if (!(el.innerText || '').trim()) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r) || inClosedSidebar(el)) continue;
    if (cs.animationName && cs.animationName !== 'none' && cs.animationPlayState === 'running') continue;
    out.blur.count++;
    if (out.blur.samples.length < maxSamples) out.blur.samples.push(sample(el, { reasons }));
  }
  out.fonts = { poppins: 'missing', families: {} };
  try {
    await document.fonts.ready;
    // Poppins puede seguir bajando de Google Fonts: esperar hasta 4 s antes de
    // declararla caída; si llega tarde se reporta como 'tardía' (hubo fallback visible).
    const poppinsLoaded = () => [...document.fonts].some((f) => /Poppins/.test(f.family) && f.status === 'loaded');
    out.fonts.lateMs = 0;
    if (!poppinsLoaded()) {
      const t0 = performance.now();
      while (!poppinsLoaded() && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 200));
      out.fonts.lateMs = Math.round(performance.now() - t0);
    }
    for (const f of document.fonts) {
      const fam = f.family.replace(/["']/g, '');
      out.fonts.families[fam] = out.fonts.families[fam] === 'loaded' ? 'loaded' : f.status;
    }
    const used = getComputedStyle(document.body).fontFamily;
    out.fonts.bodyFamily = used;
    out.fonts.poppins = out.fonts.families.Poppins || (document.fonts.check('16px Poppins') ? 'check-ok' : 'missing');
    out.fonts.poppinsUsable = document.fonts.check('16px Poppins') && out.fonts.families.Poppins === 'loaded';
  } catch (e) { out.fonts.error = String(e); }

  // ── 7. scrollbars / doble scroll ─────────────────────────────────────────
  out.scroll = { pageV: !!primary, primary: out.primaryScroller, pageH: scrollW > vw + 1, containers: [], doubleV: [], tabsOrFiltersVisibleBar: [] };
  for (const el of all) {
    const cs = getComputedStyle(el);
    const oy = cs.overflowY, ox = cs.overflowX;
    const sv = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 8; // ≤8px = redondeo/márgenes, no scroll real
    const sh = (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    if (!sv && !sh) continue;
    if (el === doc || el === document.body) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r) || inClosedSidebar(el)) continue;
    const inSidebar = !!el.closest('[data-sidebar]');
    const isTabs = el.matches('[role="tablist"]') || !!el.querySelector(':scope > [role="tab"], :scope > * > [role="tab"]');
    const isFilter = /filter|filtro|chip|pill|tabs/i.test(fullCls(el)) || (!!el.querySelector(':scope > button') && r.height < 70 && sh);
    const barW = el.offsetWidth - el.clientWidth, barH = el.offsetHeight - el.clientHeight;
    const sbw = cs.scrollbarWidth || 'auto';
    const info = sample(el, {
      v: sv, h: sh, w: Math.round(r.width), hgt: Math.round(r.height), inSidebar, isTabs, isFilter,
      scrollbar: sbw, barPx: Math.max(barW, barH),
    });
    out.scroll.containers.push(info);
    if (sv && primary && el !== primary && !inSidebar && r.height > vh * 0.35 && !el.closest('[role="dialog"]')) out.scroll.doubleV.push(info);
    if ((isTabs || isFilter) && sh && sbw !== 'none' && !/scrollbar-hide|no-scrollbar|scrollbar-none/.test(fullCls(el))) out.scroll.tabsOrFiltersVisibleBar.push(info);
  }
  out.scroll.count = out.scroll.containers.length;
  out.scroll.containers = out.scroll.containers.slice(0, maxSamples * 2);
  out.scroll.unexpectedH = out.scroll.containers.filter((c) => c.h && !c.isTabs && !c.isFilter && !/table|overflow-x-auto/.test(c.cls) && c.tag !== 'pre').slice(0, maxSamples);

  // ── 8. pestañas (shadcn Tabs / [role=tablist]) ───────────────────────────
  out.tabs = [];
  for (const tl of document.querySelectorAll('[role="tablist"]')) {
    const r = tl.getBoundingClientRect();
    if (!isVisible(tl, r) || inClosedSidebar(tl)) continue;
    const cs = getComputedStyle(tl);
    const tabs = [...tl.querySelectorAll('[role="tab"]')];
    const scrolls = tl.scrollWidth > tl.clientWidth + 1;
    const ox = cs.overflowX;
    // pestañas cortadas: fuera del rect del tablist (o de la pantalla) sin scroll posible
    const cut = tabs.filter((t) => {
      const tr = t.getBoundingClientRect();
      return tr.right > Math.min(r.right, vw) + 1 || tr.left < Math.max(r.left, 0) - 1 || tr.right > vw + 1;
    });
    // texto truncado dentro de la pestaña
    const truncated = tabs.filter((t) => t.scrollWidth > t.clientWidth + 1);
    const hasIndicator = cs.maskImage !== 'none' || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ||
      !!(tl.parentElement && [...tl.parentElement.children].some((s) => s !== tl && /gradient/.test(getComputedStyle(s).backgroundImage)));
    const small = isMobile ? tabs.filter((t) => { const tr = t.getBoundingClientRect(); return tr.width < 44 || tr.height < 44; }) : [];
    // el scroll puede estar en el TabsList o en un envoltorio (hasta 4 niveles)
    let scrollHost = null;
    for (let p = tl, i = 0; p && i < 5; p = p.parentElement, i++) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) { scrollHost = p; break; }
      if ((o === 'auto' || o === 'scroll') && p === tl) { scrollHost = p; break; }
    }
    const canScroll = !!scrollHost;
    const hostCs = scrollHost ? getComputedStyle(scrollHost) : cs;
    const visibleBar = !!scrollHost && (scrollHost.scrollWidth > scrollHost.clientWidth + 1) && (hostCs.scrollbarWidth || 'auto') !== 'none' && !/scrollbar-hide|no-scrollbar|scrollbar-none/.test(fullCls(scrollHost));
    out.tabs.push(sample(tl, {
      height: Math.round(r.height), width: Math.round(r.width), tabCount: tabs.length,
      overflowing: scrolls || (!!scrollHost && scrollHost.scrollWidth > scrollHost.clientWidth + 1), canScroll, visibleBar, scrollHost: scrollHost ? selPath(scrollHost) : null, clipped: cut.length > 0 && !canScroll, cutTabs: cut.map((t) => text(t)).slice(0, 6),
      scrollNoIndicator: canScroll && scrollHost.scrollWidth > scrollHost.clientWidth + 1 && !hasIndicator && !visibleBar, truncated: truncated.map((t) => text(t)).slice(0, 6),
      smallTabs: small.length, minTabH: tabs.length ? Math.round(Math.min(...tabs.map((t) => t.getBoundingClientRect().height))) : 0,
      scrollbar: hostCs.scrollbarWidth || 'auto',
      wrapsRows: tabs.length > 1 && new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size > 1,
    }));
  }

  // ── 9. inventario de controles alcanzables (para comparar zoom vs 100 %) ─
  // Alcanzable = visible y dentro del documento desplazable, sin un ancestro que
  // lo recorte con overflow hidden/clip (un ancestro con scroll sí lo alcanza).
  const reach = (el) => {
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) return 'oculto';
    const cs = getComputedStyle(el);
    const fixedAnc = el.closest('*') && (() => { let p = el; while (p && p !== doc) { if (getComputedStyle(p).position === 'fixed') return p; p = p.parentElement; } return null; })();
    if (fixedAnc && (r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1 || r.left < -1)) {
      // dentro de un fijo: solo alcanzable si un ancestro (dentro del fijo) hace scroll
      let p = el.parentElement, scrolls = false;
      while (p && p !== fixedAnc.parentElement) { const o = getComputedStyle(p); if (/(auto|scroll)/.test(o.overflowY + o.overflowX)) { scrolls = true; break; } p = p.parentElement; }
      if (!scrolls) return 'fuera de pantalla (fijo)';
    }
    // `cur` = dónde puede llegar a estar el elemento: al pasar por un ancestro que
    // hace scroll en un eje, el elemento se puede traer a la vista de ese
    // ancestro → en ese eje pasa a contar el rect del ancestro.
    let cur = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    let p = el.parentElement;
    while (p && p !== document.body && p !== doc) {
      const o = getComputedStyle(p);
      if (o.overflowX !== 'visible' || o.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        const canX = /(auto|scroll)/.test(o.overflowX), canY = /(auto|scroll)/.test(o.overflowY);
        const needX = cur.right <= pr.left + 1 || cur.left >= pr.right - 1;
        const needY = cur.bottom <= pr.top + 1 || cur.top >= pr.bottom - 1;
        if ((needX && !canX) || (needY && !canY)) return 'recortado por contenedor';
        // fuera (o asomando) en un eje con scroll → se puede traer al área visible del ancestro
        if (canX && (cur.left < pr.left || cur.right > pr.right)) { cur.left = pr.left; cur.right = pr.right; }
        if (canY && (cur.top < pr.top || cur.bottom > pr.bottom)) { cur.top = pr.top; cur.bottom = pr.bottom; }
      }
      p = p.parentElement;
    }
    const ax = cur.left + window.scrollX;
    if (ax + (cur.right - cur.left) <= 0 || ax >= Math.max(scrollW, vw)) return 'fuera del documento';
    return 'ok';
  };
  const keyOf = (el) => {
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const t = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return t ? `${role}:${t}` : null;
  };
  out.inventory = {};
  out.inventoryProblems = {};
  out.inventoryHidden = {};
  out.sidebarClipped = [];
  for (const el of document.querySelectorAll('button, a[href], [role="tab"], [role="button"], [role="menuitem"], input:not([type="hidden"]), select, textarea')) {
    const k = keyOf(el);
    if (!k) continue;
    if (el.closest('[data-testid="mobile-bottom-nav"]')) continue;
    const inSb = el.closest('[data-sidebar]');
    const st = reach(el);
    if (inSb) {
      const sr = inSb.getBoundingClientRect();
      if (sr.right > 0 && sr.left < vw && st !== 'ok' && st !== 'oculto') out.sidebarClipped.push({ key: k, status: st });
      continue; // el menú lateral colapsa a hamburguesa en móvil: no se compara
    }
    if (st === 'ok') out.inventory[k] = (out.inventory[k] || 0) + 1;
    else if (st !== 'oculto') out.inventoryProblems[k] = st;
    else out.inventoryHidden[k] = 1;
  }
  out.sidebarClipped = out.sidebarClipped.slice(0, maxSamples);

  // ── 10. diálogos con acciones fuera de pantalla ──────────────────────────
  out.dialogs = [];
  for (const dlg of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    const r = dlg.getBoundingClientRect();
    if (!isVisible(dlg, r)) continue;
    const btns = [...dlg.querySelectorAll('button')].filter((b) => isVisible(b));
    const off = btns.filter((b) => reach(b) !== 'ok');
    out.dialogs.push(sample(dlg, {
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), exceedsViewport: r.bottom > vh + 1 || r.top < -1,
      unreachableButtons: off.map((b) => text(b)).slice(0, 8),
    }));
  }

  // ── 11. textos encimados ─────────────────────────────────────────────────
  out.overlapText = { count: 0, samples: [] };
  {
    const leaves = [];
    for (const el of all) {
      if (leaves.length > 900) break;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) continue;
      if (inClosedSidebar(el)) continue;
      // rect del TEXTO, no de la caja (la caja puede ser más ancha que el texto)
      const range = document.createRange();
      range.selectNodeContents(el);
      const tr = range.getBoundingClientRect();
      // recortar el rect del texto por la caja que lo recorta (truncate/ellipsis/overflow)
      let rr = { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom };
      for (let p = el, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) {
        const o = getComputedStyle(p);
        if (o.overflowX !== 'visible' || o.overflowY !== 'visible' || o.textOverflow === 'ellipsis') {
          const pr = p.getBoundingClientRect();
          rr = { left: Math.max(rr.left, pr.left), right: Math.min(rr.right, pr.right), top: Math.max(rr.top, pr.top), bottom: Math.min(rr.bottom, pr.bottom) };
        }
      }
      rr.width = rr.right - rr.left; rr.height = rr.bottom - rr.top;
      if (rr.width < 4 || rr.height < 4) continue;
      if (!isVisible(el) || isSrOnly(el)) continue;
      leaves.push({ el, r: rr, fixed: fixedLayer(el) });
    }
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i], b = leaves[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.fixed !== b.fixed) continue; // un header fijo sobre contenido al hacer scroll no cuenta
        if (a.layer === undefined) a.layer = a.el.closest('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[role="menu"],[role="listbox"]');
        if (b.layer === undefined) b.layer = b.el.closest('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[role="menu"],[role="listbox"]');
        if (a.layer !== b.layer) continue; // capa flotante sobre el fondo: no es encimado
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix <= 2 || iy <= 2) continue;
        const area = ix * iy, minA = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
        if (area / minA < 0.25) continue;
        // ¿se ven los dos? el de abajo podría estar tapado por un overlay opaco
        out.overlapText.count++;
        if (out.overlapText.samples.length < maxSamples) out.overlapText.samples.push({ a: sample(a.el), b: { sel: selPath(b.el), text: text(b.el) }, overlapPct: Math.round((area / minA) * 100) });
      }
    }
  }

  // ── 12. contraste WCAG AA (texto sólido sobre el primer fondo sólido) ────
  // Aproximado: si hay imagen/degradado detrás no se mide (no se puede saber
  // el color real). Una muestra por combinación color/fondo/tamaño.
  out.contrast = { count: 0, samples: [] };
  {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        if ([...n.children].some((c) => (c.tagName === 'IMG' || c.tagName === 'VIDEO' || c.tagName === 'CANVAS') && getComputedStyle(c).position === 'absolute')) return null;
        const b = parse(cs.backgroundColor);
        if (b && b.a >= 0.95) return b;
        if (b && b.a > 0.05) return null; // fondo translúcido: depende de lo de atrás
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      const el = tn.parentElement;
      if (!el || !(tn.textContent || '').trim()) continue;
      if (!isVisible(el) || isSrOnly(el) || inClosedSidebar(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.webkitTextFillColor === 'transparent') continue;
      if (el.closest('[disabled],[aria-disabled="true"]')) continue; // WCAG exime lo deshabilitado
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.95) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const big = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
      const min = big ? 3 : 4.5;
      if (ratio >= min) continue;
      const key = `${cs.color}|${bg.r},${bg.g},${bg.b}|${big}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.contrast.count++;
      if (out.contrast.samples.length < maxSamples) out.contrast.samples.push(sample(el, { ratio: Math.round(ratio * 100) / 100, min, fg: cs.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, px: size }));
    }
  }

  // ── 13. controles sin nombre accesible ───────────────────────────────────
  out.unnamed = { count: 0, samples: [] };
  for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"]')) {
    if (!isVisible(el) || inClosedSidebar(el)) continue;
    const name = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.innerText || '').trim();
    const img = el.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
    if (name || img) continue;
    out.unnamed.count++;
    if (out.unnamed.samples.length < maxSamples) out.unnamed.samples.push(sample(el));
  }

  // ── 14. reglas V2 visibles: «¿Seguro?» en vez de Deshacer, voseo ─────────
  out.v2 = { seguro: [], voseo: [] };
  {
    const reSeguro = /¿\s*(?:Seguro|Segura|Est[áa]s?\s+segur[oa]|Realmente)(?!\p{L})/u;
    const reVoseo = /(?<!\p{L})(?:querés|tenés|podés|sabés|hacé|decí|mirá|escribí|probá|tocá|subí|completá|ingresá|revisá|agregá|seleccioná|confirmá|marcá|actualizá|cargá|guardá|usá|pagá|buscá|intentá|esperá|volvé|poné|llamá|activá|creá|enviá|contanos|escribinos|avisanos|fijate|acordate|vení|andá|ponete)(?!\p{L})/iu;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      const t = (tn.textContent || '').trim();
      const el = tn.parentElement;
      if (!t || !el || !isVisible(el) || inClosedSidebar(el)) continue;
      const ms = reSeguro.exec(t);
      if (ms && out.v2.seguro.length < maxSamples) out.v2.seguro.push(sample(el, { text: t.slice(0, 80) }));
      const mv = reVoseo.exec(t);
      if (mv && out.v2.voseo.length < maxSamples) out.v2.voseo.push(sample(el, { text: `«${mv[0]}» en: ${t.slice(0, 70)}` }));
    }
  }

  out.docHeight = doc.scrollHeight;
  out.title = document.title;
  out.h1 = (document.querySelector('main h1, h1') || {}).innerText || '';
  return out;
}
