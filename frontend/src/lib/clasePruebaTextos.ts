/**
 * Textos de un prospecto de clase de prueba que llegó por el embudo del bot de
 * WhatsApp (mig. embudo_y_agenda_clase_prueba): año, sexo, respuestas, pago.
 *
 * Puro (sin React ni Supabase). Lo usan Deportistas → Clase de prueba
 * (ProspectoDetalleEmbudo) y «Mi semana» del profe (ClasesPruebaDelDia), para
 * que la escuela y el entrenador lean al interesado con las MISMAS palabras:
 * «2011 · Mujer · Punta · Club y torneos (Club Titanes, Distrital 2025)».
 */

/** Año de nacimiento de una fecha «YYYY-MM-DD» (o de un año suelto). */
export function anioDe(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 1900 && v < 2200) return v;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 1900 && n < 2200 ? n : null;
}

/** 'female' / 'F' / 'mujer' → «Mujer»; 'male' / 'M' / 'hombre' → «Hombre». */
export function sexoTexto(v: unknown): 'Mujer' | 'Hombre' | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  if (['f', 'female', 'femenino', 'mujer', 'niña', 'nina'].includes(n)) return 'Mujer';
  if (['m', 'male', 'masculino', 'hombre', 'niño', 'nino'].includes(n)) return 'Hombre';
  return null;
}

/** Claves que el embudo guarda en columnas propias del prospecto, no como respuesta. */
const RESERVADAS = new Set(['nombre', 'full_name', 'fecha_nacimiento', 'birth_date', 'anio', 'sexo', 'genero', 'gender', 'telefono', 'phone']);

function valorTexto(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return v.map(valorTexto).filter(Boolean).join(', ');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const base = valorTexto(o.etiqueta ?? o.label ?? o.texto ?? o.valor ?? o.value ?? '');
    const det = valorTexto(o.detalle ?? '');
    return base && det ? `${base} (${det})` : base || det;
  }
  return '';
}

/**
 * Las respuestas del interesado, en orden, listas para unir con « · ».
 * Una clave `<pregunta>_detalle` (p. ej. la trayectoria «club» con sus clubes y
 * torneos) va entre paréntesis detrás de su pregunta. Un `detalle` suelto va
 * detrás de la última respuesta.
 *
 * Ojo: jsonb no guarda el orden en que se escribieron las claves (las ordena
 * por largo); por eso el detalle se pega por NOMBRE y no por posición.
 */
export function textoRespuestas(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entradas = Object.entries(raw as Record<string, unknown>).filter(([k]) => !RESERVADAS.has(k));
  const detalles = new Map<string, string>();
  let detalleSuelto = '';
  const bases: { clave: string; texto: string }[] = [];
  for (const [k, v] of entradas) {
    const t = valorTexto(v);
    if (!t) continue;
    if (k === 'detalle') { detalleSuelto = t; continue; }
    if (k.endsWith('_detalle')) { detalles.set(k.slice(0, -'_detalle'.length), t); continue; }
    bases.push({ clave: k, texto: t });
  }
  const out = bases.map((b) => (detalles.has(b.clave) ? `${b.texto} (${detalles.get(b.clave)})` : b.texto));
  // Un detalle cuya pregunta no llegó se muestra igual: es lo que escribió la familia.
  for (const [k, t] of detalles) if (!bases.some((b) => b.clave === k)) out.push(t);
  if (detalleSuelto) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} (${detalleSuelto})`;
    else out.push(detalleSuelto);
  }
  return out;
}

export type EstadoPagoProspecto = 'pagado' | 'en_revision' | null;

/**
 * Estado del pago de la clase (payments.signup_lead_id). `awaiting_approval` es
 * el comprobante que llegó por WhatsApp y la escuela todavía no revisa: la clase
 * ya quedó agendada (decisión D9, «al recibir»), pero el pago dice «En revisión».
 */
export function estadoDePago(pago: unknown): EstadoPagoProspecto {
  const estado = typeof pago === 'string'
    ? pago
    : pago && typeof pago === 'object'
      ? String((pago as Record<string, unknown>).estado ?? (pago as Record<string, unknown>).status ?? '')
      : '';
  const e = estado.trim().toLowerCase();
  if (['paid', 'pagado', 'completed', 'approved', 'aprobado'].includes(e)) return 'pagado';
  if (['awaiting_approval', 'en_revision', 'pending_review', 'in_review'].includes(e)) return 'en_revision';
  return null;
}

export function pesos(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CO')}`;
}

/** «08:00» / «08:00:00» → «8:00 a. m.» */
export function hora12(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** «2026-10-31» → «sáb 31 oct». */
export function fechaCortaConDia(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const f = new Date(y, m - 1, d);
  const dia = f.toLocaleDateString('es-CO', { weekday: 'short' }).replace('.', '');
  const mes = f.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '');
  return `${dia} ${d} ${mes}`;
}

/** «Mariana · 2011 · Mujer · Punta · Club y torneos (…)» sin las partes vacías. */
export function lineaPerfil(p: { nombre?: string | null; nacimiento?: unknown; sexo?: unknown; respuestas?: unknown }): string {
  return [
    p.nombre?.trim() || null,
    anioDe(p.nacimiento),
    sexoTexto(p.sexo),
    ...textoRespuestas(p.respuestas),
  ].filter((x) => x != null && x !== '').join(' · ');
}
