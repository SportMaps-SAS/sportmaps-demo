/**
 * Tarjeta de resultado para compartir (Instagram / WhatsApp): PNG de 1080×1350 dibujado en el
 * cliente con canvas. Sin datos de personas: equipos, marcador por sets, fase y torneo
 * (+ MVP solo con nombre público, si lo hay). Siempre «Powered by SportMaps».
 */
import { formatSetsLine, stageLabel, teamName, type DisplayMatch } from '@/lib/tournamentDisplay';

export const CARD_W = 1080;
export const CARD_H = 1350;

export interface CardTeam { name: string; logoUrl?: string | null; initials: string }

export interface ShareCardModel {
  tournament: string;
  phase: string;
  category: string | null;
  home: CardTeam;
  away: CardTeam;
  homeScore: string;
  awayScore: string;
  /** «25-22 · 25-20» (vacío en fútbol). */
  setsLine: string;
  /** «Final», «En juego», «W.O.». */
  status: string;
  /** «Cancha 3 · sáb 27 oct». */
  meta: string;
  mvp: string | null;
  winner: 'home' | 'away' | null;
}

export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

type CardMatch = DisplayMatch & {
  home_logo_url?: string | null; away_logo_url?: string | null; home_short_name?: string | null; away_short_name?: string | null;
  cup_label?: string | null; finished_at?: string | null;
};

const dayFmt = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(/\./g, '');
};

export function buildShareCardModel(
  m: CardMatch,
  opts: { tournament: string; category?: string | null; mvp?: string | null; teamLogos?: Record<string, string | null | undefined> },
): ShareCardModel {
  const hn = teamName(m, 'home');
  const an = teamName(m, 'away');
  const finished = m.status === 'played' || m.status === 'walkover';
  const hs = m.home_score ?? 0;
  const as = m.away_score ?? 0;
  const status = m.status === 'walkover' ? 'W.O.' : finished ? 'Final' : m.status === 'live' ? 'En juego' : 'Programado';
  const phase = m.cup_label ? `${m.cup_label} · ${stageLabel(m)}` : stageLabel(m);
  const logo = (side: 'home' | 'away') => (side === 'home' ? m.home_logo_url : m.away_logo_url) ?? null;
  return {
    tournament: opts.tournament,
    phase,
    category: opts.category ?? null,
    home: { name: hn, logoUrl: logo('home'), initials: m.home_short_name || initialsOf(hn) },
    away: { name: an, logoUrl: logo('away'), initials: m.away_short_name || initialsOf(an) },
    homeScore: m.status === 'scheduled' ? '-' : String(hs),
    awayScore: m.status === 'scheduled' ? '-' : String(as),
    setsLine: m.model === 'sets' ? formatSetsLine(m.sets) : '',
    status,
    meta: [m.court, dayFmt(m.finished_at ?? m.scheduled_at)].filter(Boolean).join(' · '),
    mvp: opts.mvp ?? null,
    winner: finished && hs !== as ? (hs > as ? 'home' : 'away') : null,
  };
}

/** Subconjunto de CanvasRenderingContext2D que usamos (permite probar con un contexto falso). */
export type Ctx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'
  | 'fillRect' | 'fillText' | 'beginPath' | 'arc' | 'fill' | 'stroke' | 'save' | 'restore' | 'clip' | 'drawImage' | 'measureText' | 'moveTo' | 'lineTo' | 'closePath'
  | 'createLinearGradient'>;

const COLORS = { bg1: '#0b1f4b', bg2: '#123a8a', accent: '#f5b301', text: '#ffffff', soft: 'rgba(255,255,255,0.72)', chip: 'rgba(255,255,255,0.12)' };

/** Corta el texto con «…» para que quepa en `max` px. */
export function fitText(ctx: Pick<Ctx, 'measureText'>, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function crest(ctx: Ctx, cx: number, cy: number, r: number, team: CardTeam, img: CanvasImageSource | null) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = '#ffffff'; ctx.fill();
  if (img) {
    ctx.clip();
    ctx.drawImage(img, cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
  } else {
    ctx.fillStyle = COLORS.bg1;
    ctx.font = `800 ${Math.round(r * 0.7)}px Poppins, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(team.initials, cx, cy + 2);
  }
  ctx.restore();
}

export function drawShareCard(ctx: Ctx, model: ShareCardModel, logos: { home?: CanvasImageSource | null; away?: CanvasImageSource | null } = {}) {
  const W = CARD_W; const H = CARD_H;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, COLORS.bg1); g.addColorStop(1, COLORS.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COLORS.accent; ctx.fillRect(0, 0, W, 14);

  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.soft; ctx.font = '600 38px Poppins, system-ui, sans-serif';
  ctx.fillText(fitText(ctx, model.tournament.toUpperCase(), W - 140), W / 2, 120);
  ctx.fillStyle = COLORS.text; ctx.font = '700 46px Poppins, system-ui, sans-serif';
  ctx.fillText(fitText(ctx, model.phase, W - 140), W / 2, 190);
  if (model.category) {
    ctx.fillStyle = COLORS.soft; ctx.font = '500 34px Poppins, system-ui, sans-serif';
    ctx.fillText(fitText(ctx, model.category, W - 140), W / 2, 242);
  }

  // Estado (chip)
  ctx.fillStyle = model.status === 'En juego' ? '#e11d48' : COLORS.accent;
  ctx.fillRect(W / 2 - 110, 290, 220, 64);
  ctx.fillStyle = model.status === 'En juego' ? '#ffffff' : COLORS.bg1;
  ctx.font = '800 36px Poppins, system-ui, sans-serif';
  ctx.fillText(model.status.toUpperCase(), W / 2, 335);

  // Escudos + nombres
  const cy = 540; const r = 120;
  crest(ctx, 270, cy, r, model.home, logos.home ?? null);
  crest(ctx, W - 270, cy, r, model.away, logos.away ?? null);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const [side, x] of [['home', 270], ['away', W - 270]] as const) {
    const t = model[side];
    ctx.globalAlpha = model.winner && model.winner !== side ? 0.7 : 1;
    ctx.fillStyle = COLORS.text; ctx.font = '700 44px Poppins, system-ui, sans-serif';
    ctx.fillText(fitText(ctx, t.name, 420), x, cy + r + 80);
    ctx.globalAlpha = 1;
  }

  // Marcador
  ctx.fillStyle = COLORS.text; ctx.font = '800 220px Poppins, system-ui, sans-serif';
  ctx.fillText(`${model.homeScore}`, W / 2 - 150, 1010);
  ctx.fillText(`${model.awayScore}`, W / 2 + 150, 1010);
  ctx.fillStyle = COLORS.soft; ctx.font = '700 120px Poppins, system-ui, sans-serif';
  ctx.fillText('-', W / 2, 985);
  if (model.setsLine) {
    ctx.fillStyle = COLORS.text; ctx.font = '600 48px Poppins, system-ui, sans-serif';
    ctx.fillText(fitText(ctx, model.setsLine, W - 140), W / 2, 1090);
  }
  if (model.mvp) {
    ctx.fillStyle = COLORS.accent; ctx.font = '700 40px Poppins, system-ui, sans-serif';
    ctx.fillText(fitText(ctx, `⭐ MVP: ${model.mvp}`, W - 140), W / 2, 1160);
  }
  if (model.meta) {
    ctx.fillStyle = COLORS.soft; ctx.font = '500 32px Poppins, system-ui, sans-serif';
    ctx.fillText(fitText(ctx, model.meta, W - 140), W / 2, 1215);
  }

  // Pie
  ctx.fillStyle = COLORS.chip; ctx.fillRect(0, H - 90, W, 90);
  ctx.fillStyle = COLORS.text; ctx.font = '600 32px Poppins, system-ui, sans-serif';
  ctx.fillText('Powered by SportMaps · sportmaps.co', W / 2, H - 34);
}

/** Carga un logo con CORS; si falla (o tarda), se usan las iniciales. */
export function loadImage(url: string | null | undefined, timeoutMs = 2500): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

export async function renderShareCardPng(model: ShareCardModel): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W; canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Tu navegador no permite crear la imagen.');
  const [home, away] = await Promise.all([loadImage(model.home.logoUrl), loadImage(model.away.logoUrl)]);
  try { if ('fonts' in document) await (document as any).fonts.ready; } catch { /* sin fuentes web */ }
  try {
    drawShareCard(ctx, model, { home, away });
    return await toBlob(canvas);
  } catch {
    // Un logo sin CORS «ensucia» el canvas: se repinta con iniciales.
    drawShareCard(ctx, model, {});
    return toBlob(canvas);
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen.'))), 'image/png'));
}

export function shareFileName(model: ShareCardModel): string {
  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(model.home.name)}-vs-${slug(model.away.name)}.png`;
}

export function shareText(model: ShareCardModel, url?: string): string {
  const base = `${model.status === 'Final' ? 'Final' : model.status}: ${model.home.name} ${model.homeScore}-${model.awayScore} ${model.away.name}${model.setsLine ? ` (${model.setsLine.replace(/ · /g, ', ')})` : ''} · ${model.tournament}`;
  return url ? `${base}\n${url}` : base;
}
