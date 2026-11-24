import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * QA visual automático de las páginas públicas (DESIGN.md §10).
 *
 * Por cada página × ancho × tema:
 *  - guarda captura de página completa en test-results/visual-qa/
 *  - mide problemas objetivos y los escribe en test-results/visual-qa/<id>.json
 *
 * Solo FALLA por lo bloqueante (errores JS no capturados y scroll horizontal).
 * El resto (táctil, alt, contraste, enlaces muertos) se reporta para revisión:
 * `node e2e/visual-qa/resumen.mjs` arma el informe en markdown.
 */

const PAGES = (process.env.QA_PAGES || '/,/login,/register,/ayuda,/explorar,/terminos-y-condiciones,/politica-de-privacidad')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

const VIEWPORTS = [
    { name: 'movil-360', width: 360, height: 780, mobile: true },
    { name: 'tablet-768', width: 768, height: 1024, mobile: true },
    { name: 'escritorio-1440', width: 1440, height: 900, mobile: false },
];

const THEMES = ['light', 'dark'] as const;

const OUT = path.join(process.cwd(), 'test-results', 'visual-qa');

type Hallazgo = { tipo: string; detalle: string; selector?: string };

async function auditar(page: Page, mobile: boolean): Promise<Hallazgo[]> {
    return page.evaluate((isMobile) => {
        const out: { tipo: string; detalle: string; selector?: string }[] = [];
        const sel = (el: Element) => {
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
            const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
            return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}${txt ? ` «${txt}»` : ''}`;
        };
        const visible = (el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
        };

        // 1. Scroll horizontal de página
        const sw = document.documentElement.scrollWidth;
        const cw = document.documentElement.clientWidth;
        if (sw > cw + 1) {
            const culpables = [...document.querySelectorAll('body *')]
                .filter((el) => visible(el) && el.getBoundingClientRect().right > cw + 1)
                .slice(0, 5)
                .map(sel);
            out.push({ tipo: 'scroll-horizontal', detalle: `scrollWidth ${sw}px > viewport ${cw}px`, selector: culpables.join(' | ') });
        }

        // 2. Objetivos táctiles < 44px (solo móvil)
        if (isMobile) {
            const interactivos = [...document.querySelectorAll('a[href], button, [role="button"], input:not([type=hidden]), select, textarea')];
            for (const el of interactivos) {
                if (!visible(el)) continue;
                const r = el.getBoundingClientRect();
                // Enlaces dentro de un párrafo están exentos (WCAG 2.5.8 «inline»).
                if (el.tagName === 'A' && el.closest('p, li') && getComputedStyle(el).display === 'inline') continue;
                if (r.width < 44 || r.height < 44) {
                    out.push({ tipo: 'tactil-chico', detalle: `${Math.round(r.width)}×${Math.round(r.height)}px`, selector: sel(el) });
                }
            }
        }

        // 3. Imágenes sin alt
        for (const img of document.querySelectorAll('img')) {
            if (!img.hasAttribute('alt') && visible(img)) out.push({ tipo: 'img-sin-alt', detalle: img.currentSrc.slice(-60), selector: sel(img) });
        }

        // 4. Enlaces muertos y botones sin nombre
        for (const a of document.querySelectorAll('a[href="#"], a[href=""]')) {
            if (visible(a)) out.push({ tipo: 'enlace-muerto', detalle: 'href="#"', selector: sel(a) });
        }
        for (const b of document.querySelectorAll('button, a[href], [role="button"]')) {
            if (!visible(b)) continue;
            const nombre = (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim();
            const imgAlt = b.querySelector('img[alt]:not([alt=""])');
            if (!nombre && !imgAlt) out.push({ tipo: 'sin-nombre-accesible', detalle: 'interactivo sin texto ni aria-label', selector: sel(b) });
        }

        // 5. Encabezados: exactamente un h1
        const h1 = [...document.querySelectorAll('h1')].filter(visible).length;
        if (h1 !== 1) out.push({ tipo: 'h1', detalle: `${h1} h1 visibles (se espera 1)` });

        // 6. Contraste de texto (aprox.: color vs primer fondo sólido de ancestros)
        const parse = (c: string) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
            return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        };
        const lum = (c: { r: number; g: number; b: number }) => {
            const f = (v: number) => {
                v /= 255;
                return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const fondo = (el: Element | null): { r: number; g: number; b: number } | 'imagen' | null => {
            while (el) {
                const cs = getComputedStyle(el);
                if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'imagen';
                // Texto encima de una <img> posicionada (heros): no se puede medir aquí.
                if ([...el.children].some((c) => c.tagName === 'IMG' && getComputedStyle(c).position === 'absolute')) return 'imagen';
                const bg = parse(cs.backgroundColor);
                if (bg && bg.a >= 0.95) return bg;
                el = el.parentElement;
            }
            return { r: 255, g: 255, b: 255 };
        };
        const vistos = new Set<string>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
            const t = (n.textContent || '').trim();
            const el = n.parentElement;
            if (!t || !el || !visible(el)) continue;
            const cs = getComputedStyle(el);
            if (cs.webkitTextFillColor === 'transparent' || cs.color === 'transparent') continue;
            const fg = parse(cs.color);
            const bg = fondo(el);
            if (!fg || !bg || bg === 'imagen' || fg.a < 0.95) continue;
            const L1 = lum(fg), L2 = lum(bg);
            const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
            const size = parseFloat(cs.fontSize);
            const bold = Number(cs.fontWeight) >= 700;
            const grande = size >= 24 || (bold && size >= 18.66);
            const min = grande ? 3 : 4.5;
            if (ratio < min) {
                const key = `${cs.color}|${JSON.stringify(bg)}|${grande}`;
                if (vistos.has(key)) continue;
                vistos.add(key);
                out.push({ tipo: 'contraste', detalle: `${ratio.toFixed(2)}:1 (mín ${min}) ${cs.color} sobre rgb(${bg.r},${bg.g},${bg.b}) · ${size}px`, selector: sel(el) });
            }
        }

        // 7. Texto menor a 12px
        const chicos = new Set<string>();
        for (const el of document.querySelectorAll('body *')) {
            if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent?.trim())) continue;
            if (!visible(el)) continue;
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (fs < 12 && chicos.size < 10) {
                chicos.add(sel(el));
                out.push({ tipo: 'texto-chico', detalle: `${fs}px`, selector: sel(el) });
            }
        }
        return out;
    }, mobile);
}

for (const ruta of PAGES) {
    for (const vp of VIEWPORTS) {
        for (const theme of THEMES) {
            const id = `${ruta === '/' ? 'inicio' : ruta.replace(/^\//, '').replace(/\W+/g, '-')}__${vp.name}__${theme}`;
            test(id, async ({ browser }) => {
                const context = await browser.newContext({
                    viewport: { width: vp.width, height: vp.height },
                    isMobile: vp.mobile,
                    hasTouch: vp.mobile,
                    colorScheme: theme,
                    reducedMotion: 'reduce',
                });
                await context.addInitScript((t) => {
                    try {
                        localStorage.setItem('theme', t);
                    } catch {
                        /* sin storage */
                    }
                }, theme);
                const page = await context.newPage();

                const erroresJs: string[] = [];
                const sinCatchRed: string[] = [];
                const consola: string[] = [];
                page.on('pageerror', (e) => {
                    // Con la base apagada a propósito, un fetch rechazado sin catch
                    // no es un bug visual; se reporta aparte (en producción con red
                    // mala sí le pasa al usuario).
                    if (!process.env.QA_BASE_URL && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) sinCatchRed.push(e.message);
                    else erroresJs.push(e.message);
                });
                page.on('console', (m) => {
                    if (m.type() !== 'error') return;
                    const txt = m.text();
                    // Ruido esperado: la base es inalcanzable a propósito.
                    if (/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to fetch|Failed to load resource/i.test(txt)) return;
                    consola.push(txt.slice(0, 300));
                });

                const t0 = Date.now();
                await page.goto(ruta, { waitUntil: 'domcontentloaded' });
                await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
                await page.waitForTimeout(500);
                const cargaMs = Date.now() - t0;

                fs.mkdirSync(OUT, { recursive: true });
                await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: true });

                const hallazgos = await auditar(page, vp.mobile);
                if (sinCatchRed.length) hallazgos.push({ tipo: 'promesa-sin-catch-red', detalle: `${sinCatchRed.length} rechazo(s) de red sin manejar: ${sinCatchRed[0]}` });
                const urlFinal = new URL(page.url()).pathname;
                fs.writeFileSync(
                    path.join(OUT, `${id}.json`),
                    JSON.stringify({ id, ruta, urlFinal, viewport: vp.name, theme, cargaMs, erroresJs, consola, hallazgos }, null, 2),
                );
                await context.close();

                expect(erroresJs, 'errores JS no capturados').toEqual([]);
                expect(hallazgos.filter((h) => h.tipo === 'scroll-horizontal'), 'scroll horizontal de página').toEqual([]);
            });
        }
    }
}
