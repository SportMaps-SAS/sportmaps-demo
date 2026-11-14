import { forwardRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, AlertTriangle, XCircle, CalendarDays, Hash, MapPin, Users, Heart, Phone, Shirt, User, Lock } from 'lucide-react';
import { translateRevocationReason } from '@/lib/cards/cardLayout';

export type CardLayout = 'classic' | 'modern' | 'minimal' | 'photo' | 'stripe';
export type CardPattern = 'none' | 'diagonal' | 'dots' | 'grid' | 'waves';
export type CardPhotoShape = 'rounded' | 'circle' | 'square';
export type CardTextMode = 'auto' | 'light' | 'dark';

export type CardData = {
  found: boolean;
  status: 'active' | 'revoked' | 'expired' | string;
  /** Quién está mirando, según la RPC: el público no recibe datos médicos,
   *  de emergencia, documento ni pagos (mig 20261010201231). */
  viewer?: 'public' | 'staff' | 'guardian';
  card_id?: string;
  qr_token?: string;
  issued_at?: string;
  valid_until?: string;
  version?: number;
  school?: {
    id: string;
    name: string;
    slug?: string | null;
    logo_url?: string | null;
    branding_settings?: any;
  };
  template?: {
    id: string;
    name: string;
    accent_color?: string | null;
    secondary_color?: string | null;
    layout?: CardLayout | null;
    pattern?: CardPattern | null;
    photo_shape?: CardPhotoShape | null;
    text_mode?: CardTextMode | null;
    background_url?: string | null;
    header_text?: string | null;
    footer_text?: string | null;
    show_fields?: Record<string, boolean>;
  } | null;
  athlete?: {
    kind: 'child' | 'profile' | 'unregistered';
    full_name: string;
    avatar_url?: string | null;
    doc_type?: string | null;
    doc_number?: string | null;
    date_of_birth?: string | null;
    blood_type?: string | null;
    eps_name?: string | null;
    tshirt_size?: string | null;
    emergency_contact?: string | null;
    gender?: string | null;
    role?: string | null;
  };
  branch_name?: string | null;
  team_name?: string | null;
  monthly_fee?: number | null;
  fee_status?: 'paid' | 'due_soon' | 'overdue' | 'no_payments' | 'unknown';
  last_paid_at?: string | null;
  next_due?: string | null;
  last_payment?: {
    concept?: string | null;
    amount?: number | null;
    amount_paid?: number | null;
    payment_date?: string | null;
    created_at?: string | null;
    provider_reference?: string | null;
    payment_method?: string | null;
  } | null;
  revoked_at?: string;
  reason?: string;
  /** Filas libres (carné de torneo: número, apodo, posición…). Se muestran después de las de siempre. */
  extra_rows?: Array<{ label: string; value: string }>;
  /** Filas libres del REVERSO (carné de torneo: campos propios de la ficha, como EPS o talla). */
  back_rows?: Array<{ label: string; value: string }>;
};

const FEE_BADGE: Record<string, { label: string; bg: string; fg: string; icon: typeof ShieldCheck }> = {
  paid:        { label: 'Cuota al día',       bg: '#16a34a', fg: '#ffffff', icon: ShieldCheck },
  due_soon:    { label: 'Próxima a vencer',   bg: '#eab308', fg: '#1f2937', icon: AlertTriangle },
  overdue:     { label: 'Cuota vencida',      bg: '#dc2626', fg: '#ffffff', icon: XCircle },
  no_payments: { label: 'Sin pagos',          bg: '#6b7280', fg: '#ffffff', icon: AlertTriangle },
  unknown:     { label: 'Estado desconocido', bg: '#6b7280', fg: '#ffffff', icon: AlertTriangle },
};

const DEFAULT_SHOW: Record<string, boolean> = {
  photo: true, doc_number: true, team: true, branch: true, plan: true,
  valid_until: true, fee_status: true, blood_type: false,
  emergency_contact: false, eps: false, tshirt_size: false,
};

/** Medidas fijas: la relación 340×540 es la de una CR80 (54 × 85,6 mm), que es
 *  lo que se imprime y plastifica. Cambiarla descuadra el PDF de 9 por hoja. */
const CARD_W = 340;
const CARD_H = 540;

interface Props {
  data: CardData;
  publicUrl: string;
  className?: string;
  /** Cara a mostrar. 'back' muestra datos de emergencia/médicos. Default 'front'. */
  face?: 'front' | 'back';
  /** 'print' quita la sombra y las esquinas redondeadas: es lo que se captura
   *  para el PDF/PNG (se recorta en rectángulo con las marcas de corte). */
  variant?: 'screen' | 'print';
}

/** Todo lo que los cinco layouts necesitan resuelto una sola vez. */
type Theme = {
  layout: CardLayout;
  primary: string;
  secondary: string;
  /** Fondo del lienzo: gradiente de marca (o gris muy claro en los layouts claros). */
  canvas: string;
  /** true → el texto va oscuro sobre fondo claro. */
  darkText: boolean;
  ink: (a: number) => string;
  inkColor: string;
  pattern: string;
  photoShape: string;
  backgroundUrl: string | null;
};

export const AthleteIdCard = forwardRef<HTMLDivElement, Props>(({ data, publicUrl, className = '', face = 'front', variant = 'screen' }, ref) => {
  const t = resolveTheme(data);
  const show = { ...DEFAULT_SHOW, ...(data.template?.show_fields || {}) };
  const feeKey = data.fee_status || 'unknown';
  const feeBadge = FEE_BADGE[feeKey] || FEE_BADGE.unknown;
  const isInactive = data.status === 'revoked' || data.status === 'expired';
  const showWatermark: boolean = (data.school?.branding_settings || {}).show_sportmaps_watermark !== false;

  const ctx: LayoutCtx = { data, t, show, publicUrl, feeBadge, feeKey };

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden ${variant === 'print' ? '' : 'rounded-2xl shadow-2xl'} ${className}`}
      style={{ width: CARD_W, height: CARD_H, background: t.canvas, color: t.inkColor }}
    >
      {/* Imagen de fondo de la plantilla, si la escuela subió una. El velo de
          color encima es lo que mantiene el texto legible sobre cualquier foto. */}
      {t.backgroundUrl && (
        <>
          <img
            src={t.backgroundUrl}
            alt=""
            crossOrigin="anonymous"
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0" style={{ background: t.canvas, opacity: 0.82 }} />
        </>
      )}

      {/* Textura */}
      {t.pattern && <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: t.pattern }} />}

      {/* Brillo diagonal: barato en CSS y en impresión da el aire de tarjeta
          plastificada en vez de papel. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: `linear-gradient(115deg, ${t.ink(0.12)} 0%, transparent 42%, transparent 58%, ${t.ink(0.07)} 100%)` }}
      />

      {face === 'back'
        ? <BackFace ctx={ctx} />
        : (
          <>
            {t.layout === 'modern'  && <ModernFace  ctx={ctx} />}
            {t.layout === 'minimal' && <MinimalFace ctx={ctx} />}
            {t.layout === 'photo'   && <PhotoFace   ctx={ctx} />}
            {t.layout === 'stripe'  && <StripeFace  ctx={ctx} />}
            {t.layout === 'classic' && <ClassicFace ctx={ctx} />}
          </>
        )}

      {showWatermark && (
        <div className="absolute bottom-1 right-2 text-[8px] select-none z-20" style={{ color: 'rgba(125,125,125,0.75)' }}>
          SportMaps
        </div>
      )}

      {isInactive && (
        <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center z-30">
          <XCircle className="h-12 w-12 text-red-400 mb-2" />
          <p className="text-white font-bold uppercase tracking-wider">
            {data.status === 'revoked' ? 'Carnet revocado' : 'Carnet vencido'}
          </p>
          {data.reason && <p className="text-white/80 text-xs mt-1 px-6 text-center">{translateRevocationReason(data.reason)}</p>}
        </div>
      )}
    </div>
  );
});

AthleteIdCard.displayName = 'AthleteIdCard';

// ───────────────────────────────────────────────────────────────────────────
// Tema
// ───────────────────────────────────────────────────────────────────────────

function resolveTheme(data: CardData): Theme {
  const branding = data.school?.branding_settings || {};
  const tpl = data.template || ({} as NonNullable<CardData['template']>);
  const layout: CardLayout = (tpl.layout as CardLayout) || 'classic';

  const primary: string = tpl.accent_color || branding.primary_color || '#0ea5e9';
  // El segundo color sale de la plantilla; si no hay, de la marca; y si tampoco,
  // se deriva del primario. Antes caía a un azul fijo, así que toda plantilla
  // sin marca terminaba en el mismo degradado y ningún carnet se veía propio.
  const secondary: string = tpl.secondary_color || branding.secondary_color || shade(primary, -0.4);

  const lightCanvas = layout === 'minimal' || layout === 'stripe';
  const canvas = lightCanvas
    ? '#f7f8fa'
    : `linear-gradient(160deg, ${primary} 0%, ${secondary} 100%)`;

  const mode: CardTextMode = (tpl.text_mode as CardTextMode) || 'auto';
  const darkText = mode === 'dark' ? true
    : mode === 'light' ? false
    : lightCanvas ? true : isLightColor(primary, secondary);

  const inkColor = darkText ? '#141414' : '#ffffff';
  const ink = (a: number) => (darkText ? `rgba(20,20,20,${a})` : `rgba(255,255,255,${a})`);

  return {
    layout,
    primary,
    secondary,
    canvas,
    darkText,
    ink,
    inkColor,
    pattern: patternCss((tpl.pattern as CardPattern) || 'diagonal', darkText ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.10)'),
    photoShape: photoRadius((tpl.photo_shape as CardPhotoShape) || 'rounded'),
    backgroundUrl: tpl.background_url || null,
  };
}

/** Texturas en CSS puro: html2canvas (que es quien genera el PNG y el PDF) sabe
 *  rasterizar gradientes lineales y radiales, pero no máscaras ni filtros. */
function patternCss(pattern: CardPattern, c: string): string {
  switch (pattern) {
    case 'none':
      return '';
    case 'dots':
      return `radial-gradient(${c} 1.4px, transparent 1.4px)`;
    case 'grid':
      return `linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`;
    case 'waves':
      return `radial-gradient(circle at 15% 20%, ${c} 0 90px, transparent 91px), `
           + `radial-gradient(circle at 85% 55%, ${c} 0 120px, transparent 121px), `
           + `radial-gradient(circle at 30% 95%, ${c} 0 70px, transparent 71px)`;
    case 'diagonal':
    default:
      return `repeating-linear-gradient(45deg, ${c} 0 10px, transparent 10px 20px)`;
  }
}

function photoRadius(shape: CardPhotoShape): string {
  if (shape === 'circle') return '9999px';
  if (shape === 'square') return '4px';
  return '18px';
}

// ───────────────────────────────────────────────────────────────────────────
// Piezas compartidas
// ───────────────────────────────────────────────────────────────────────────

type LayoutCtx = {
  data: CardData;
  t: Theme;
  show: Record<string, boolean>;
  publicUrl: string;
  feeBadge: (typeof FEE_BADGE)[string];
  feeKey: string;
};

function Logo({ ctx, size = 48 }: { ctx: LayoutCtx; size?: number }) {
  const { data, t } = ctx;
  if (data.school?.logo_url) {
    return (
      <img
        src={data.school.logo_url}
        alt=""
        crossOrigin="anonymous"
        className="rounded-lg object-contain p-1 shrink-0"
        style={{ height: size, width: size, background: 'rgba(255,255,255,0.95)' }}
      />
    );
  }
  return (
    <div
      className="rounded-lg flex items-center justify-center font-bold shrink-0"
      style={{
        height: size,
        width: size,
        fontSize: size * 0.42,
        background: t.darkText ? 'rgba(0,0,0,0.86)' : 'rgba(255,255,255,0.95)',
        color: t.darkText ? '#ffffff' : t.primary,
      }}
    >
      {data.school?.name?.[0] || '?'}
    </div>
  );
}

function Photo({ ctx, size }: { ctx: LayoutCtx; size: number }) {
  const { data, t } = ctx;
  const initials = getInitials(data.athlete?.full_name);
  return (
    <div
      className="overflow-hidden shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: t.photoShape,
        background: 'rgba(255,255,255,0.95)',
        boxShadow: `0 0 0 4px ${t.ink(0.35)}`,
      }}
    >
      {data.athlete?.avatar_url ? (
        <img src={data.athlete.avatar_url} alt={data.athlete.full_name} className="w-full h-full object-cover" crossOrigin="anonymous" />
      ) : (
        <div className="w-full h-full flex items-center justify-center font-extrabold" style={{ fontSize: size * 0.34, color: t.primary }}>
          {initials || <User className="h-1/3 w-1/3 text-gray-400" />}
        </div>
      )}
    </div>
  );
}

function DocLine({ ctx, className = '' }: { ctx: LayoutCtx; className?: string }) {
  const { data, t, show } = ctx;
  if (!show.doc_number || !data.athlete?.doc_number) return null;
  return (
    <p className={`text-xs flex items-center gap-1 tabular-nums ${className}`} style={{ color: t.ink(0.85) }}>
      <Hash className="h-3 w-3" />
      {data.athlete.doc_type || 'CC'} {data.athlete.doc_number}
    </p>
  );
}

/** Filas de datos comunes a varios layouts (sede, equipo, RH, EPS, talla…). */
function dataRows(ctx: LayoutCtx): { icon: typeof ShieldCheck; label: string; value: string }[] {
  const { data, show } = ctx;
  const rows: { icon: typeof ShieldCheck; label: string; value: string }[] = [];
  if (show.branch && data.branch_name) rows.push({ icon: MapPin, label: 'Sede', value: data.branch_name });
  if (show.team && data.team_name) rows.push({ icon: Users, label: 'Equipo', value: data.team_name });
  if (show.blood_type && data.athlete?.blood_type) rows.push({ icon: Heart, label: 'RH', value: data.athlete.blood_type });
  if (show.eps && data.athlete?.eps_name) rows.push({ icon: Heart, label: 'EPS', value: data.athlete.eps_name });
  if (show.tshirt_size && data.athlete?.tshirt_size) rows.push({ icon: Shirt, label: 'Talla', value: data.athlete.tshirt_size });
  if (show.emergency_contact && data.athlete?.emergency_contact) rows.push({ icon: Phone, label: 'Emergencia', value: data.athlete.emergency_contact });
  for (const r of data.extra_rows ?? []) if (r.value) rows.push({ icon: ShieldCheck, label: r.label, value: r.value });
  return rows;
}

function Row({ icon: Icon, label, value, t }: { icon: typeof ShieldCheck; label: string; value: string; t: Theme }) {
  return (
    <div className="flex items-center gap-2" style={{ color: t.inkColor }}>
      <div className="p-1 rounded shrink-0" style={{ background: t.ink(0.2) }}>
        <Icon className="h-3 w-3" />
      </div>
      {/* w-20: «EMERGENCIA» no cabía en w-16 y se montaba sobre el valor. El valor
          puede ir en dos renglones: cortado con «…» el teléfono quedaba ilegible. */}
      <span className="text-[10px] uppercase tracking-wider w-20 shrink-0" style={{ color: t.ink(0.7) }}>{label}</span>
      <span className="text-xs font-medium leading-snug break-words min-w-0 flex-1">{value}</span>
    </div>
  );
}

/** Bloque de datos en dos columnas — el que usan modern y minimal. */
function DataGrid({ ctx }: { ctx: LayoutCtx }) {
  const rows = dataRows(ctx);
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0">
          <div className="text-[9px] uppercase tracking-wider" style={{ color: ctx.t.ink(0.6) }}>{r.label}</div>
          <div className="text-[11px] font-semibold truncate" style={{ color: ctx.t.inkColor }}>{r.value}</div>
        </div>
      ))}
    </div>
  );
}

function FeeBadge({ ctx }: { ctx: LayoutCtx }) {
  const { show, feeBadge, feeKey } = ctx;
  if (!show.fee_status || feeKey === 'unknown') return null;
  const Icon = feeBadge.icon;
  return (
    <div
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ backgroundColor: feeBadge.bg, color: feeBadge.fg }}
    >
      <Icon className="h-3 w-3" />
      {feeBadge.label}
    </div>
  );
}

function ValidUntil({ ctx, align = 'right' }: { ctx: LayoutCtx; align?: 'right' | 'left' }) {
  const { data, t, show } = ctx;
  if (!show.valid_until || !data.valid_until) return null;
  return (
    <p className={`text-[11px] flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`} style={{ color: t.ink(0.85) }}>
      <CalendarDays className="h-3 w-3" />
      Vence {new Date(data.valid_until).toLocaleDateString('es-CO')}
    </p>
  );
}

function Qr({ publicUrl, size = 72 }: { publicUrl: string; size?: number }) {
  return (
    <div className="bg-white p-1.5 rounded-lg shrink-0">
      <QRCodeSVG value={publicUrl} size={size} level="M" />
    </div>
  );
}

function LastPayment({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, show, feeKey } = ctx;
  if (!show.fee_status || !data.last_payment) return null;
  if (!['paid', 'due_soon', 'overdue'].includes(feeKey)) return null;
  const amount = data.last_payment.amount_paid ?? data.last_payment.amount;
  const when = data.last_payment.payment_date || data.last_payment.created_at;
  return (
    <div className="rounded-md px-2 py-1 text-[10px] leading-tight" style={{ background: t.ink(0.15), color: t.ink(0.95) }}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{data.last_payment.concept || 'Último pago'}</span>
        {typeof amount === 'number' && <span className="font-semibold tabular-nums">{formatCop(amount)}</span>}
      </div>
      {when && (
        <p className="text-[9px] mt-0.5" style={{ color: t.ink(0.7) }}>
          Pagado {new Date(when).toLocaleDateString('es-CO')}
        </p>
      )}
    </div>
  );
}

function Footer({ ctx, className = '' }: { ctx: LayoutCtx; className?: string }) {
  const txt = ctx.data.template?.footer_text;
  if (!txt) return null;
  return (
    <p className={`text-[9px] leading-tight ${className}`} style={{ color: ctx.t.ink(0.6) }}>{txt}</p>
  );
}

function Version({ ctx }: { ctx: LayoutCtx }) {
  if (!ctx.data.version || ctx.data.version <= 1) return null;
  return <p className="text-[10px]" style={{ color: ctx.t.ink(0.6) }}>v{ctx.data.version}</p>;
}

// ───────────────────────────────────────────────────────────────────────────
// Layouts
// ───────────────────────────────────────────────────────────────────────────

/** Clásico: el de siempre. Escudo arriba, retrato centrado, datos y barra de QR.
 *
 *  Va en columna flex y no con la barra en `absolute`: con los diez campos
 *  encendidos las filas de datos se montaban encima del QR y del último pago.
 *  Además, pasadas cuatro filas se cambia a dos columnas — en una sola no
 *  entran sin apretar la tipografía hasta lo ilegible. */
function ClassicFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, show, publicUrl } = ctx;
  const rows = dataRows(ctx);
  const dense = rows.length > 4;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="px-5 pt-5 pb-3 flex items-center gap-3 shrink-0" style={{ borderBottom: `1px solid ${t.ink(0.2)}` }}>
        <Logo ctx={ctx} />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wider font-medium" style={{ color: t.ink(0.7) }}>
            {data.template?.header_text || 'Carnet deportivo'}
          </p>
          <h3 className="font-bold text-base leading-tight truncate" style={{ color: t.inkColor }}>
            {data.school?.name}
          </h3>
        </div>
      </div>

      <div className="px-5 pt-4 flex flex-col items-center text-center shrink-0">
        {show.photo && <div className="mb-3"><Photo ctx={ctx} size={dense ? 92 : 110} /></div>}
        <p className="font-bold text-lg leading-tight max-w-full break-words" style={{ color: t.inkColor }}>
          {data.athlete?.full_name || '—'}
        </p>
        <DocLine ctx={ctx} className="mt-0.5" />
      </div>

      <div className="px-5 mt-3 flex-1 min-h-0 overflow-hidden">
        {dense ? (
          <DataGrid ctx={ctx} />
        ) : (
          <div className="space-y-1.5">
            {rows.map((r) => <Row key={r.label} icon={r.icon} label={r.label} value={r.value} t={t} />)}
          </div>
        )}
      </div>

      <div
        className="px-5 pb-4 pt-3 shrink-0"
        style={{ background: t.darkText ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.18)' }}
      >
        <div className="mb-2"><LastPayment ctx={ctx} /></div>
        <div className="flex items-center justify-between gap-3">
          <Qr publicUrl={publicUrl} />
          <div className="flex-1 text-right space-y-1">
            <FeeBadge ctx={ctx} />
            <ValidUntil ctx={ctx} />
            <Version ctx={ctx} />
          </div>
        </div>
        <Footer ctx={ctx} className="text-center mt-2" />
      </div>
    </div>
  );
}

/** Moderno: bloque de color arriba con el retrato montado sobre el borde y los
 *  datos en dos columnas sobre un panel claro. El más "tarjeta de socio". */
function ModernFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, show, publicUrl } = ctx;
  return (
    <>
      {/* px fijos a propósito: cara de tarjeta CR80 de tamaño de impresión, no responsive */}
      <div className="relative px-5 pt-5 flex items-start gap-3" style={{ height: 168 }}>
        <Logo ctx={ctx} size={40} />
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[9px] uppercase tracking-[0.18em] font-medium" style={{ color: t.ink(0.7) }}>
            {data.template?.header_text || 'Carnet deportivo'}
          </p>
          <h3 className="font-bold text-sm leading-tight truncate" style={{ color: t.inkColor }}>
            {data.school?.name}
          </h3>
        </div>
      </div>

      {/* Panel claro: el contraste con el bloque de arriba es lo que da el look */}
      <div className="absolute left-0 right-0" style={{ top: 168, bottom: 0, background: 'rgba(255,255,255,0.94)', borderTopLeftRadius: 28, borderTopRightRadius: 28 }} />

      {show.photo && (
        <div className="absolute z-10" style={{ top: 168 - 52, left: 20 }}>
          <Photo ctx={ctx} size={104} />
        </div>
      )}

      <div className="absolute z-10 left-0 right-0 px-5 overflow-hidden" style={{ top: 168 + 62, bottom: 132, color: '#141414' }}>
        <p className="font-extrabold text-[17px] leading-tight break-words" style={{ color: '#111827' }}>
          {data.athlete?.full_name || '—'}
        </p>
        {show.doc_number && data.athlete?.doc_number && (
          <p className="text-xs mt-0.5 flex items-center gap-1 tabular-nums" style={{ color: '#6b7280' }}>
            <Hash className="h-3 w-3" />
            {data.athlete.doc_type || 'CC'} {data.athlete.doc_number}
          </p>
        )}

        <div className="mt-3 h-px" style={{ background: 'rgba(0,0,0,0.10)' }} />

        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          {dataRows(ctx).map((r) => (
            <div key={r.label} className="min-w-0">
              <div className="text-[9px] uppercase tracking-wider" style={{ color: '#9ca3af' }}>{r.label}</div>
              <div className="text-[11px] font-semibold truncate" style={{ color: '#111827' }}>{r.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="absolute left-0 right-0 bottom-0 px-5 pb-4 z-10">
        {show.fee_status && data.last_payment && ['paid', 'due_soon', 'overdue'].includes(ctx.feeKey) && (
          <div className="mb-2 rounded-md px-2 py-1 text-[10px] leading-tight" style={{ background: 'rgba(0,0,0,0.05)', color: '#374151' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{data.last_payment.concept || 'Último pago'}</span>
              {typeof (data.last_payment.amount_paid ?? data.last_payment.amount) === 'number' && (
                <span className="font-semibold tabular-nums">{formatCop((data.last_payment.amount_paid ?? data.last_payment.amount)!)}</span>
              )}
            </div>
          </div>
        )}
        <div className="flex items-end justify-between gap-3">
          <Qr publicUrl={publicUrl} size={66} />
          <div className="flex-1 text-right space-y-1">
            <FeeBadge ctx={ctx} />
            {show.valid_until && data.valid_until && (
              <p className="text-[11px] flex items-center justify-end gap-1" style={{ color: '#6b7280' }}>
                <CalendarDays className="h-3 w-3" />
                Vence {new Date(data.valid_until).toLocaleDateString('es-CO')}
              </p>
            )}
            {data.version && data.version > 1 && <p className="text-[10px]" style={{ color: '#9ca3af' }}>v{data.version}</p>}
          </div>
        </div>
        {data.template?.footer_text && (
          <p className="text-[9px] text-center mt-2 leading-tight" style={{ color: '#9ca3af' }}>{data.template.footer_text}</p>
        )}
      </div>
    </>
  );
}

/** Minimal: fondo claro, una regla de color arriba y tipografía grande. Es el
 *  que mejor imprime en impresoras de tarjetas baratas (poca tinta de fondo). */
function MinimalFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, show, publicUrl } = ctx;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0" style={{ height: 8, background: `linear-gradient(90deg, ${t.primary}, ${t.secondary})` }} />

      <div className="px-5 pt-5 flex items-center gap-3 shrink-0">
        <Logo ctx={ctx} size={36} />
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-[0.2em]" style={{ color: t.ink(0.55) }}>
            {data.template?.header_text || 'Carnet deportivo'}
          </p>
          <h3 className="font-bold text-[13px] leading-tight truncate" style={{ color: t.inkColor }}>{data.school?.name}</h3>
        </div>
      </div>

      <div className="px-5 mt-5 flex items-center gap-4 shrink-0">
        {show.photo && <Photo ctx={ctx} size={92} />}
        <div className="min-w-0">
          <p className="font-extrabold text-[18px] leading-[1.15] break-words" style={{ color: t.inkColor }}>
            {data.athlete?.full_name || '—'}
          </p>
          <DocLine ctx={ctx} className="mt-1" />
        </div>
      </div>

      <div className="px-5 mt-5 flex-1 min-h-0 overflow-hidden">
        <div className="h-px mb-3" style={{ background: t.ink(0.12) }} />
        <DataGrid ctx={ctx} />
      </div>

      <div className="px-5 pb-4 pt-2 shrink-0">
        <div className="mb-2"><LastPayment ctx={ctx} /></div>
        <div className="flex items-end justify-between gap-3">
          <Qr publicUrl={publicUrl} size={64} />
          <div className="flex-1 text-right space-y-1">
            <FeeBadge ctx={ctx} />
            <ValidUntil ctx={ctx} />
            <Version ctx={ctx} />
          </div>
        </div>
        <Footer ctx={ctx} className="text-center mt-2" />
      </div>
    </div>
  );
}

/** Foto: retrato a sangre con degradado encima. El de más impacto, pero exige
 *  que el atleta tenga foto — sin foto cae a las iniciales gigantes. */
function PhotoFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, publicUrl } = ctx;
  const initials = getInitials(data.athlete?.full_name);
  return (
    <>
      <div className="absolute inset-0">
        {data.athlete?.avatar_url ? (
          <img src={data.athlete.avatar_url} alt="" crossOrigin="anonymous" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center font-black" style={{ fontSize: 120, color: 'rgba(255,255,255,0.22)' }}>
            {initials}
          </div>
        )}
      </div>
      {/* Velo: arriba tinta de marca, abajo negro para que el nombre se lea */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(180deg, ${hexToRgba(t.primary, 0.92)} 0%, ${hexToRgba(t.primary, 0.25)} 34%, rgba(0,0,0,0.35) 62%, rgba(0,0,0,0.88) 100%)` }}
      />

      <div className="absolute inset-0 flex flex-col">
      <div className="px-5 pt-5 flex items-center gap-3 shrink-0">
        <Logo ctx={ctx} size={40} />
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-[0.18em]" style={{ color: 'rgba(255,255,255,0.75)' }}>
            {data.template?.header_text || 'Carnet deportivo'}
          </p>
          <h3 className="font-bold text-[13px] leading-tight truncate text-white">{data.school?.name}</h3>
        </div>
      </div>

      <div className="mt-auto px-5 pb-4 text-white">
        <p className="font-extrabold text-xl leading-tight break-words drop-shadow">{data.athlete?.full_name || '—'}</p>
        {ctx.show.doc_number && data.athlete?.doc_number && (
          <p className="text-xs mt-0.5 flex items-center gap-1 tabular-nums" style={{ color: 'rgba(255,255,255,0.85)' }}>
            <Hash className="h-3 w-3" />
            {data.athlete.doc_type || 'CC'} {data.athlete.doc_number}
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {dataRows(ctx).slice(0, 4).map((r) => (
            <div key={r.label} className="min-w-0">
              {/* max-w en px: layout fijo de la tarjeta CR80 impresa */}
              <div className="text-[8px] uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.65)' }}>{r.label}</div>
              <div className="text-[11px] font-semibold truncate max-w-[130px]">{r.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <Qr publicUrl={publicUrl} size={62} />
          <div className="flex-1 text-right space-y-1">
            <FeeBadge ctx={ctx} />
            {ctx.show.valid_until && data.valid_until && (
              <p className="text-[11px] flex items-center justify-end gap-1" style={{ color: 'rgba(255,255,255,0.85)' }}>
                <CalendarDays className="h-3 w-3" />
                Vence {new Date(data.valid_until).toLocaleDateString('es-CO')}
              </p>
            )}
          </div>
        </div>
        {data.template?.footer_text && (
          <p className="text-[9px] text-center mt-2 leading-tight" style={{ color: 'rgba(255,255,255,0.6)' }}>{data.template.footer_text}</p>
        )}
      </div>
      </div>
    </>
  );
}

/** Franja: banda de color vertical con el nombre de la escuela rotado. */
function StripeFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, show, publicUrl } = ctx;
  const STRIPE = 62;
  return (
    <>
      <div
        className="absolute top-0 bottom-0 left-0 flex items-center justify-center"
        style={{ width: STRIPE, background: `linear-gradient(180deg, ${t.primary}, ${t.secondary})` }}
      >
        <span
          className="uppercase font-bold tracking-[0.28em] text-[11px] whitespace-nowrap text-white"
          style={{ transform: 'rotate(-90deg)' }}
        >
          {data.school?.name}
        </span>
      </div>

      <div className="absolute top-0 bottom-0 right-0 flex flex-col" style={{ left: STRIPE }}>
        <div className="px-4 pt-5 flex items-center gap-2 shrink-0">
          <Logo ctx={ctx} size={34} />
          <p className="text-[9px] uppercase tracking-[0.18em]" style={{ color: t.ink(0.6) }}>
            {data.template?.header_text || 'Carnet deportivo'}
          </p>
        </div>

        <div className="px-4 mt-4 flex flex-col items-start shrink-0">
          {show.photo && <div className="mb-3"><Photo ctx={ctx} size={96} /></div>}
          <p className="font-extrabold text-[17px] leading-tight break-words" style={{ color: t.inkColor }}>
            {data.athlete?.full_name || '—'}
          </p>
          <DocLine ctx={ctx} className="mt-1" />
        </div>

        <div className="px-4 mt-4 flex-1 min-h-0 overflow-hidden">
          <div className="h-px mb-3" style={{ background: t.ink(0.12) }} />
          <DataGrid ctx={ctx} />
        </div>

        <div className="px-4 pb-4 pt-2 shrink-0">
          <div className="mb-2"><LastPayment ctx={ctx} /></div>
          <div className="flex items-end justify-between gap-2">
            <Qr publicUrl={publicUrl} size={58} />
            <div className="flex-1 text-right space-y-1">
              <FeeBadge ctx={ctx} />
              <ValidUntil ctx={ctx} />
              <Version ctx={ctx} />
            </div>
          </div>
          <Footer ctx={ctx} className="text-center mt-2" />
        </div>
      </div>
    </>
  );
}

/** Reverso: datos médicos / de emergencia + QR + términos. Igual para todos los
 *  layouts — es la cara que se lee en una urgencia, no el lugar para lucirse. */
function BackFace({ ctx }: { ctx: LayoutCtx }) {
  const { data, t, publicUrl, show } = ctx;
  const a = data.athlete;
  // Respeta los show_fields de la plantilla (la RPC ya los filtra; esto cubre
  // la vista previa del editor, que arma los datos a mano).
  const rows: [string, string | null | undefined, boolean][] = [
    ['Contacto de emergencia', a?.emergency_contact, !!show.emergency_contact],
    ['EPS', a?.eps_name, !!show.eps],
    ['RH', a?.blood_type, !!show.blood_type],
    ['Talla', a?.tshirt_size, !!show.tshirt_size],
  ];
  const shown = [
    ...rows.filter(([, v, on]) => on && !!v),
    ...(data.back_rows ?? []).filter((r) => !!r.value).map((r): [string, string, boolean] => [r.label, r.value, true]),
  ];
  const isPublic = data.viewer === 'public';
  return (
    <div className="relative h-full px-5 pt-5 pb-4 flex flex-col" style={{ color: t.inkColor }}>
      <div className="flex items-center gap-3 pb-3" style={{ borderBottom: `1px solid ${t.ink(0.2)}` }}>
        <Logo ctx={ctx} size={36} />
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-[0.18em]" style={{ color: t.ink(0.6) }}>Datos de emergencia</p>
          <h3 className="font-bold text-[13px] leading-tight truncate">{data.school?.name}</h3>
        </div>
      </div>

      <div className="mt-2">
        <p className="text-sm font-bold leading-tight break-words">{a?.full_name || '—'}</p>
        {(data.team_name || data.branch_name) && (
          <p className="text-[10px] leading-snug mt-0.5" style={{ color: t.ink(0.75) }}>
            {[data.team_name, data.branch_name].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <div className="mt-3 space-y-3">
        {shown.length > 0 ? (
          shown.map(([k, v]) => (
            <div key={k}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: t.ink(0.6) }}>{k}</div>
              <div className="text-sm font-semibold leading-snug break-words">{v}</div>
            </div>
          ))
        ) : isPublic ? (
          <p className="text-xs flex items-start gap-1.5 leading-snug" style={{ color: t.ink(0.75) }}>
            <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Los datos médicos y de emergencia solo los ven la escuela y el acudiente con su sesión iniciada.
          </p>
        ) : (
          <p className="text-xs leading-snug" style={{ color: t.ink(0.6) }}>
            Sin datos médicos configurados en la plantilla de este carnet.
          </p>
        )}
      </div>

      <div className="my-4" style={{ borderTop: `1px solid ${t.ink(0.2)}` }} />

      <div className="flex items-center gap-3">
        <Qr publicUrl={publicUrl} size={64} />
        <p className="text-[10px] leading-snug" style={{ color: t.ink(0.85) }}>
          Escanea para <strong>validar este carnet</strong> en línea. Estado en tiempo real.
        </p>
      </div>

      <p className="text-[9px] leading-relaxed mt-auto" style={{ color: t.ink(0.6) }}>
        {data.template?.footer_text
          || 'Documento de identificación deportiva. Válido solo con foto y QR legibles. En caso de pérdida, la escuela puede revocarlo y reemitir una nueva versión.'}
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────────────────────

function formatCop(amount: number): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `$${Math.round(amount).toLocaleString('es-CO')}`;
  }
}

// Iniciales del atleta (primeras letras de las 2 primeras palabras del nombre).
function getInitials(name?: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0][0] || '';
  const second = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + second).toUpperCase();
}

function parseHex(hex: string): [number, number, number] {
  const h = (hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Aclara (amount > 0) u oscurece (amount < 0) un color. Se usa para derivar el
 *  segundo color del gradiente cuando la plantilla no define uno. */
function shade(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ¿El gradiente de la marca es "claro"? Promedia la luminancia relativa de los
// dos colores; si supera el umbral, el texto debe ir oscuro para ser legible.
function isLightColor(c1: string, c2: string): boolean {
  const lum = (hex: string): number => {
    const [r, g, b] = parseHex(hex);
    // luminancia perceptual (0..255)
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  const avg = (lum(c1) + lum(c2)) / 2;
  return avg > 165; // umbral: marcas claras (amarillo/lima/pastel) → texto oscuro
}
