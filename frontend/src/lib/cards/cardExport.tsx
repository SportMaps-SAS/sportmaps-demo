/**
 * Exportación de carnets a PNG y PDF (html2canvas + jsPDF), compartida por la
 * vista de la escuela, la del acudiente y la página pública.
 *
 * Tres causas de que la descarga saliera "como una imagen mal hecha" y cómo se
 * atacan acá:
 *
 * 1. Texto cortado abajo. html2canvas mide la línea base de cada fuente con un
 *    <img> de 1 px puesto en línea junto a un <span> en el documento REAL. El
 *    preflight de Tailwind deja `img { display: block }`, así que ese <img> cae
 *    en la línea siguiente, la línea base sale ~1 renglón más abajo y todo texto
 *    dentro de un contenedor con overflow (truncate) queda mochado. Se corrige
 *    con una regla que solo alcanza a ese <img> de medición (ver TEXT_FIX_CSS).
 *
 * 2. Fotos en blanco. Los avatares pueden ser SVG (dicebear) o venir de otro
 *    dominio; html2canvas no rasteriza bien SVG en <img> y no soporta
 *    object-fit. Antes de capturar, cada imagen se baja con fetch, se recorta
 *    (cover/contain) en un canvas y se pasa como data URL PNG. Si no se puede
 *    bajar, se quita y el carnet muestra las iniciales — nunca un cuadro blanco.
 *
 * 3. Tamaño y reverso. El PDF ubica cada cara a 53,98 × 85,6 mm exactos y
 *    siempre incluye el reverso (hoja de reversos en espejo o frente y reverso
 *    lado a lado); el PNG lleva las dos caras en una sola imagen.
 */
import { createRoot } from 'react-dom/client';
import { AthleteIdCard, type CardData } from '@/components/cards/AthleteIdCard';
import { AthleteCard3D } from '@/components/cards/AthleteCard3D';
import type { Carnet3DDatos } from './contratos';
import { escudoPorDefecto } from './clubIdentity';
import {
  CARD_CSS_H,
  CARD_CSS_W,
  PDF_CAPTURE_SCALE,
  PNG_CAPTURE_SCALE,
  computePdfPages,
  cutMarkSegments,
  type PdfLayoutMode,
} from './cardLayout';

const SMALL_IMAGE_PREFIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP';
const TEXT_FIX_CSS = `img[src^="${SMALL_IMAGE_PREFIX}"]{display:inline !important;vertical-align:baseline !important;}`;

function ensureHtml2canvasTextFix() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('sm-h2c-text-fix')) return;
  const s = document.createElement('style');
  s.id = 'sm-h2c-text-fix';
  s.textContent = TEXT_FIX_CSS;
  document.head.appendChild(s);
}

// ───────────────────────────────────────────────────────────────────────────
// Imágenes → data URL
// ───────────────────────────────────────────────────────────────────────────

type Fit = 'cover' | 'contain';
const imageCache = new Map<string, Promise<string | null>>();

function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No cargó la imagen ${src.slice(0, 80)}`));
    img.src = src;
  });
}

function drawFitted(img: HTMLImageElement, outW: number, outH: number, fit: Fit): string {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d no disponible');
  // SVG sin width/height reporta 0: se trata como cuadrado.
  const iw = img.naturalWidth || outW;
  const ih = img.naturalHeight || outW;
  const scale = fit === 'cover' ? Math.max(outW / iw, outH / ih) : Math.min(outW / iw, outH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  return canvas.toDataURL('image/png');
}

async function rasterize(url: string, outW: number, outH: number, fit: Fit): Promise<string | null> {
  // 1) fetch → blob: evita la respuesta cacheada sin CORS (la que dejó un <img>
  //    normal en la tabla) y sirve para SVG.
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (res.ok) {
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = await loadImage(objectUrl, false);
        return drawFitted(img, outW, outH, fit);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
  } catch {
    // sigue con el plan B
  }
  // 2) <img crossOrigin> con un parámetro para saltar la caché.
  try {
    const sep = url.includes('?') ? '&' : '?';
    const img = await loadImage(`${url}${sep}_sm_export=${Date.now()}`, true);
    return drawFitted(img, outW, outH, fit);
  } catch {
    return null;
  }
}

function cachedRaster(url: string | null | undefined, outW: number, outH: number, fit: Fit): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  if (url.startsWith('data:')) return Promise.resolve(url);
  const key = `${url}|${outW}x${outH}|${fit}`;
  let p = imageCache.get(key);
  if (!p) {
    p = rasterize(url, outW, outH, fit);
    imageCache.set(key, p);
  }
  return p;
}

/** Copia del carnet con todas sus imágenes ya rasterizadas como data URL. */
export async function inlineCardImages(data: CardData): Promise<CardData> {
  const isPhotoLayout = data.template?.layout === 'photo';
  const [logo, avatar, bg] = await Promise.all([
    cachedRaster(data.school?.logo_url, 256, 256, 'contain'),
    // La foto va cuadrada en todos los layouts salvo 'photo', que es a sangre.
    isPhotoLayout
      ? cachedRaster(data.athlete?.avatar_url, CARD_CSS_W * 2.5, CARD_CSS_H * 2.5, 'cover')
      : cachedRaster(data.athlete?.avatar_url, 512, 512, 'cover'),
    cachedRaster(data.template?.background_url, CARD_CSS_W * 2.5, CARD_CSS_H * 2.5, 'cover'),
  ]);
  return {
    ...data,
    school: data.school ? { ...data.school, logo_url: logo } : data.school,
    athlete: data.athlete ? { ...data.athlete, avatar_url: avatar } : data.athlete,
    template: data.template ? { ...data.template, background_url: bg } : data.template,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Render fuera de pantalla + captura
// ───────────────────────────────────────────────────────────────────────────

export type CardExportItem = { data: CardData; publicUrl: string };

type RenderedFaces = { front: HTMLElement; back: HTMLElement }[];

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function waitForImages(root: HTMLElement) {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(imgs.map(async (img) => {
    if (!img.complete) {
      await new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); });
    }
    try { await img.decode(); } catch { /* ya está o falló: se captura igual */ }
  }));
}

/**
 * Monta frente y reverso de cada carnet en un contenedor fuera de pantalla,
 * espera fuentes e imágenes, llama a `fn` con los nodos y desmonta.
 */
async function withRenderedFaces<T>(items: CardExportItem[], fn: (faces: RenderedFaces) => Promise<T>): Promise<T> {
  ensureHtml2canvasTextFix();
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(
      <div>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            <div data-face="front" data-i={i}><AthleteIdCard data={it.data} publicUrl={it.publicUrl} face="front" variant="print" /></div>
            <div data-face="back" data-i={i}><AthleteIdCard data={it.data} publicUrl={it.publicUrl} face="back" variant="print" /></div>
          </div>
        ))}
      </div>,
    );
    await nextFrame();
    if (document.fonts?.ready) await document.fonts.ready;
    await waitForImages(host);
    await nextFrame();
    const faces: RenderedFaces = items.map((_, i) => ({
      front: host.querySelector<HTMLElement>(`[data-face="front"][data-i="${i}"] > div`)!,
      back: host.querySelector<HTMLElement>(`[data-face="back"][data-i="${i}"] > div`)!,
    }));
    return await fn(faces);
  } finally {
    root.unmount();
    host.remove();
  }
}

async function capture(node: HTMLElement, scale: number, background: string | null): Promise<HTMLCanvasElement> {
  const html2canvas = (await import('html2canvas')).default;
  return html2canvas(node, {
    scale,
    useCORS: true,
    backgroundColor: background,
    logging: false,
    width: CARD_CSS_W,
    height: CARD_CSS_H,
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** PNG con frente y reverso lado a lado, a resolución de impresión. */
export async function exportCardPng(item: CardExportItem, fileBase: string): Promise<void> {
  const data = await inlineCardImages(item.data);
  await withRenderedFaces([{ ...item, data }], async ([faces]) => {
    const front = await capture(faces.front, PNG_CAPTURE_SCALE, '#ffffff');
    const back = await capture(faces.back, PNG_CAPTURE_SCALE, '#ffffff');
    const gap = Math.round(24 * PNG_CAPTURE_SCALE);
    const out = document.createElement('canvas');
    out.width = front.width + gap + back.width;
    out.height = Math.max(front.height, back.height);
    const ctx = out.getContext('2d')!;
    // Fondo blanco: con transparencia, muchos visores pintan el espacio entre
    // caras de negro.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(front, 0, 0);
    ctx.drawImage(back, front.width + gap, 0);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen');
    downloadBlob(blob, `${fileBase}-frente-y-reverso.png`);
  });
}

export type PdfExportOptions = {
  mode: PdfLayoutMode;
  cutMarks: boolean;
  fileName: string;
  onProgress?: (done: number, total: number) => void;
};

/** Hojas de carnets CR80 con frente y reverso. Procesa de a 9 para no reventar la memoria. */
export async function exportCardsPdf(items: CardExportItem[], opts: PdfExportOptions): Promise<number> {
  if (items.length === 0) return 0;
  const { jsPDF } = await import('jspdf');
  const pages = computePdfPages(items.length, opts.mode);
  const pdf = new jsPDF({ orientation: pages[0].orientation, unit: 'mm', format: 'a4', compress: true });

  // Caras capturadas por carnet, de a un "pliego" (las hojas que comparten carnets).
  const CHUNK = 9;
  const faceImages = new Map<number, { front: string; back: string }>();
  let done = 0;
  opts.onProgress?.(0, items.length);

  async function ensureCaptured(from: number, to: number) {
    const slice = items.slice(from, to);
    const inlined = await Promise.all(slice.map(async (it) => ({ ...it, data: await inlineCardImages(it.data) })));
    await withRenderedFaces(inlined, async (faces) => {
      for (let k = 0; k < faces.length; k++) {
        // Fondo blanco + JPEG: es papel, y un PNG por cara a 300 dpi hace PDFs enormes.
        const f = await capture(faces[k].front, PDF_CAPTURE_SCALE, '#ffffff');
        const b = await capture(faces[k].back, PDF_CAPTURE_SCALE, '#ffffff');
        faceImages.set(from + k, { front: f.toDataURL('image/jpeg', 0.93), back: b.toDataURL('image/jpeg', 0.93) });
        done++;
        opts.onProgress?.(done, items.length);
      }
    });
  }

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (p > 0) pdf.addPage('a4', page.orientation);
    for (const face of page.faces) {
      if (!faceImages.has(face.card)) {
        const from = Math.floor(face.card / CHUNK) * CHUNK;
        await ensureCaptured(from, Math.min(items.length, from + CHUNK));
      }
      const imgs = faceImages.get(face.card)!;
      pdf.addImage(face.face === 'front' ? imgs.front : imgs.back, 'JPEG', face.x, face.y, face.w, face.h, undefined, 'FAST');
      if (opts.cutMarks) {
        pdf.setDrawColor(150);
        pdf.setLineWidth(0.15);
        for (const [x1, y1, x2, y2] of cutMarkSegments(face)) pdf.line(x1, y1, x2, y2);
      }
    }
    // Las caras de carnets cuyas hojas ya salieron no se vuelven a usar.
    const lastCardOnPage = Math.max(...page.faces.map((f) => f.card));
    const stillNeeded = new Set(pages.slice(p + 1).flatMap((pg) => pg.faces.map((f) => f.card)));
    for (const k of Array.from(faceImages.keys())) {
      if (k <= lastCardOnPage && !stillNeeded.has(k)) faceImages.delete(k);
    }
  }

  pdf.save(opts.fileName);
  return items.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Carnet 3D: «Descargar imagen» PLANA (spec §7: sin efectos y sin estado de
// habilitación). Frente y reverso lado a lado, a resolución de impresión,
// con la misma captura (html2canvas) y la misma rasterización de imágenes
// que el carnet clásico. Impresión y PDF por equipo siguen con las
// plantillas clásicas (spec §11.1).
// ───────────────────────────────────────────────────────────────────────────

/** Copia de los datos del carnet 3D con foto y escudo ya rasterizados (PNG). */
export async function inlineCarnet3DImages(datos: Carnet3DDatos): Promise<Carnet3DDatos> {
  const escudo = datos.identidad.escudoUrl || escudoPorDefecto(datos.identidad);
  const [foto, escudoPng] = await Promise.all([
    cachedRaster(datos.fotoUrl, 512, 512, 'cover'),
    // El escudo por defecto es un data URI SVG: html2canvas no lo rasteriza
    // bien dentro de un <img>, así que pasa por canvas igual que los remotos.
    escudo.startsWith('data:image/svg')
      ? loadImage(escudo, false).then((img) => drawFitted(img, 400, 480, 'contain')).catch(() => null)
      : cachedRaster(escudo, 400, 480, 'contain'),
  ]);
  return {
    ...datos,
    fotoUrl: foto,
    identidad: { ...datos.identidad, escudoUrl: escudoPng ?? datos.identidad.escudoUrl },
  };
}

export async function exportCarnet3DPng(datos: Carnet3DDatos, fileBase: string): Promise<void> {
  ensureHtml2canvasTextFix();
  const listos = await inlineCarnet3DImages(datos);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(
      <div style={{ display: 'flex', gap: 16 }}>
        <AthleteCard3D datos={listos} modo="plano" />
        <AthleteCard3D datos={listos} modo="plano" reversoInicial />
      </div>,
    );
    await nextFrame();
    if (document.fonts?.ready) await document.fonts.ready;
    await waitForImages(host);
    await nextFrame();
    const frenteNodo = host.querySelector<HTMLElement>('[data-carnet3d-cara="frente"]');
    const reversoNodo = host.querySelector<HTMLElement>('[data-carnet3d-cara="reverso"]');
    if (!frenteNodo || !reversoNodo) throw new Error('No se pudo preparar el carnet');
    // Esquinas redondeadas: fondo transparente en las caras, blanco en el lienzo final.
    const front = await capture(frenteNodo, PNG_CAPTURE_SCALE, null);
    const back = await capture(reversoNodo, PNG_CAPTURE_SCALE, null);
    const gap = Math.round(24 * PNG_CAPTURE_SCALE);
    const out = document.createElement('canvas');
    out.width = front.width + gap + back.width;
    out.height = Math.max(front.height, back.height);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(front, 0, 0);
    ctx.drawImage(back, front.width + gap, 0);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen');
    downloadBlob(blob, `${fileBase}.png`);
  } finally {
    root.unmount();
    host.remove();
  }
}
