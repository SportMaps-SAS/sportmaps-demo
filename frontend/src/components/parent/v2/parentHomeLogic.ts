/**
 * Inicio del acudiente (V2) — lógica pura, sin React ni Supabase.
 *
 * Todo lo que decide QUÉ frase se muestra vive aquí para poder probarlo sin
 * montar la pantalla: cuánto debe la familia, de quién, cuándo vence, cuál es
 * el próximo entreno y qué dato le falta a un hijo.
 */
import { chargeCategoryOf } from '@/lib/payment-accounts';
import { PAYABLE_STATES } from './pagosModel';
import { timeParts, type AgendaItem } from './parentCalendarModel';

/** Inicio V2 solo para el acudiente. Los demás roles siguen con el tablero de siempre. */
export const usaInicioAcudienteV2 = (role: string | null | undefined): boolean => role === 'parent';

/**
 * Estados que significan «esto todavía se debe». Son los MISMOS que Pagos
 * ofrece para pagar (PAYABLE_STATES de pagosModel): Inicio nunca puede decir
 * «Todo al día» sobre un cobro que Pagos le pide pagar (rechazado o fallido incluidos).
 */
export const ESTADOS_QUE_SE_DEBEN = PAYABLE_STATES;

/** Con estos el atajo `/my-payments?pay=<id>` abre el pago directo (DIRECTLY_PAYABLE_STATES de MyPaymentsPage). */
const PAGABLES_DIRECTO = ['pending', 'overdue'];

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export interface Cobro {
  id: string;
  amount: number;
  amount_paid: number | null;
  status: string;
  child_id: string | null;
  parent_id: string | null;
  due_date: string | null;
  period_year: number | null;
  period_month: number | null;
  concept: string | null;
  payment_category: string | null;
  school_id?: string | null;
  created_at?: string | null;
  early_payment_discount_applied?: number | null;
  /** Descuento por pronto pago vigente (lo calcula useParentHomeData igual que Pagos). */
  pronto_pago?: number;
}

/** Franja de `teams.schedule`. `day` sigue a Date.getDay() (0 = domingo). */
export interface Franja {
  day: number;
  time: string;
  end?: string;
  place?: string;
}

export interface Hijo {
  id: string;
  nombre: string;
  avatarUrl: string | null;
  equipo: string | null;
  profe: string | null;
  lugar: string | null;
  franjas: Franja[];
  eps: string | null;
  fraseProfe: string | null;
  escuela: string | null;
}

// ── Fechas ───────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' (o timestamp) → fecha local a medianoche, sin corrimiento de zona. */
export function fechaLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const soloDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const diasEntre = (a: Date, b: Date) => Math.round((soloDia(b).getTime() - soloDia(a).getTime()) / 86_400_000);

/** «Jueves 8 de octubre». */
export function fechaCabecera(hoy: Date): string {
  const t = `${DIAS[hoy.getDay()]} ${hoy.getDate()} de ${MESES[hoy.getMonth()]}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Punto final de una frase, sin duplicarlo cuando ya termina en «p. m.». */
export const conPuntoFinal = (frase: string) => (/\.\s*$/.test(frase) ? frase.trimEnd() : `${frase.trimEnd()}.`);

/** «4:00 p. m.» a partir de «16:00» o «16:00:00». */
export function horaColombia(hhmm: string): string {
  const [hS, mS = '00'] = hhmm.split(':');
  const h = Number(hS);
  if (Number.isNaN(h)) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mS.padStart(2, '0').slice(0, 2)} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Frase del vencimiento: «Vence hoy.», «Vence el sábado 11.», «Venció el 5 de octubre.». */
export function fraseVencimiento(dueIso: string | null, hoy: Date): string | null {
  const due = fechaLocal(dueIso);
  if (!due) return null;
  const d = diasEntre(hoy, due);
  if (d === 0) return 'Vence hoy.';
  if (d === 1) return 'Vence mañana.';
  if (d > 1 && d <= 6) return `Vence el ${DIAS[due.getDay()]} ${due.getDate()}.`;
  if (d > 6) return `Vence el ${due.getDate()} de ${MESES[due.getMonth()]}.`;
  return `Venció el ${due.getDate()} de ${MESES[due.getMonth()]}.`;
}

// ── Plata ────────────────────────────────────────────────────────────────────

export const primerNombre = (n: string | null | undefined) => (n ?? '').trim().split(/\s+/)[0] || '';

/**
 * Lo que falta por pagar de un cobro (un abono parcial ya no se debe), menos el
 * pronto pago vigente. Misma cuenta que `dueAmount` de Pagos: Inicio y Pagos
 * tienen que decir el mismo valor. El cobro real lo fija el BFF.
 */
export const saldo = (c: Cobro) => {
  const pronto = c.status === 'partial' ? 0 : Number(c.pronto_pago || 0);
  return Math.max(Number(c.amount || 0) - Number(c.amount_paid || 0) - pronto, 0);
};

export const cobrosQueSeDeben = (cobros: Cobro[]) =>
  cobros.filter((c) => ESTADOS_QUE_SE_DEBEN.includes(c.status) && saldo(c) > 0);

/** «la mensualidad de octubre», «la inscripción», «un cobro». */
export function queSeDebe(c: Cobro): string {
  const cat = chargeCategoryOf(c.payment_category, c.concept) ?? (c.payment_category ? null : 'mensualidad');
  if (cat === 'mensualidad') {
    const mes = c.period_month && c.period_month >= 1 && c.period_month <= 12 ? MESES[c.period_month - 1] : null;
    return mes ? `la mensualidad de ${mes}` : 'la mensualidad';
  }
  if (cat === 'inscripcion') return 'la inscripción';
  if (cat === 'seguro') return 'el seguro';
  if (cat === 'torneo') return 'el torneo';
  if (cat === 'articulos') return 'los artículos';
  if (cat === 'excedente') return 'las horas adicionales';
  if (cat === 'clase_extra') return 'la clase extra';
  if (cat === 'vacacional') return 'el vacacional';
  if (cat === 'viaje') return 'el viaje';
  return 'un cobro';
}

/** Texto del chip de un hijo: «Al día», «Debe octubre», «Debe la inscripción», «Debe 2 cobros». */
export function chipHijo(cobrosDelHijo: Cobro[]): { texto: string; debe: boolean } {
  if (cobrosDelHijo.length === 0) return { texto: 'Al día', debe: false };
  if (cobrosDelHijo.length > 1) return { texto: `Debe ${cobrosDelHijo.length} cobros`, debe: true };
  const que = queSeDebe(cobrosDelHijo[0]);
  const mes = /^la mensualidad de (.+)$/.exec(que);
  return { texto: mes ? `Debe ${mes[1]}` : `Debe ${que}`, debe: true };
}

export interface ResumenFamilia {
  debe: boolean;
  titulo: string;
  subtitulo: string | null;
  total: number;
  /** A dónde lleva «Pagar»: el cobro directo si es uno solo, si no la lista. */
  pagarHref: string;
}

export function resumenFamilia(
  cobros: Cobro[],
  hijos: Pick<Hijo, 'id' | 'nombre'>[],
  nombreAcudiente: string,
  hoy: Date,
): ResumenFamilia {
  const deudas = cobrosQueSeDeben(cobros);
  if (deudas.length === 0) {
    const n = primerNombre(nombreAcudiente);
    return { debe: false, titulo: n ? `Todo al día, ${n}.` : 'Todo al día.', subtitulo: null, total: 0, pagarHref: '/my-payments' };
  }

  const nombreDe = (childId: string | null) =>
    childId ? primerNombre(hijos.find((h) => h.id === childId)?.nombre) || null : null;
  const total = deudas.reduce((s, c) => s + saldo(c), 0);
  const deudores = [...new Set(deudas.map((c) => c.child_id ?? '__yo'))];

  let titulo: string;
  if (deudas.length === 1) {
    const c = deudas[0];
    const quien = nombreDe(c.child_id);
    const que = queSeDebe(c);
    titulo = quien
      ? `Falta ${que} de ${quien}.`
      : `Falta ${que.replace(/^la /, 'tu ').replace(/^el /, 'tu ').replace(/^los /, 'tus ').replace(/^las /, 'tus ')}.`;
  } else if (deudores.length === 1 && deudores[0] !== '__yo' && nombreDe(deudores[0])) {
    titulo = `${nombreDe(deudores[0])} tiene ${deudas.length} cobros pendientes.`;
  } else {
    titulo = `Tienes ${deudas.length} cobros pendientes.`;
  }

  // El vencimiento más cercano (o el más viejo, si ya pasó).
  const masUrgente = [...deudas]
    .filter((c) => fechaLocal(c.due_date))
    .sort((a, b) => fechaLocal(a.due_date)!.getTime() - fechaLocal(b.due_date)!.getTime())[0];
  const partes: string[] = [];
  const venc = masUrgente ? fraseVencimiento(masUrgente.due_date, hoy) : null;
  if (venc && deudas.length === 1) partes.push(venc);
  else if (venc && masUrgente) {
    // Con varios cobros, decir de CUÁL es la fecha: «Venció el 13 de agosto»
    // suelto se leía como si fuera todo lo que se debe.
    const quien = nombreDe(masUrgente.child_id);
    const que = `${queSeDebe(masUrgente)}${quien ? ` de ${quien}` : ''}`;
    const vencido = venc.startsWith('Venció');
    const cuando = venc.replace(/^Venció /, '').replace(/^Vence /, '').replace(/\.$/, '');
    partes.push(vencido
      ? `El más antiguo, ${que}, venció el ${cuando.replace(/^el /, '')}.`
      : `El próximo, ${que}, vence ${cuando}.`);
  }
  const alDia = hijos.filter((h) => !deudas.some((c) => c.child_id === h.id)).map((h) => primerNombre(h.nombre)).filter(Boolean);
  if (alDia.length === 1) partes.push(`Lo de ${alDia[0]} está al día.`);
  else if (alDia.length > 1) partes.push(`Lo de ${alDia.slice(0, -1).join(', ')} y ${alDia[alDia.length - 1]} está al día.`);

  const unico = deudas.length === 1 && PAGABLES_DIRECTO.includes(deudas[0].status) ? deudas[0] : null;
  return {
    debe: true,
    titulo,
    subtitulo: partes.length ? partes.join(' ') : null,
    total,
    pagarHref: unico ? `/my-payments?pay=${unico.id}` : '/my-payments',
  };
}

// ── Horarios ─────────────────────────────────────────────────────────────────

/** Lee `teams.schedule` con la misma tolerancia que HorariosDeEntrenamiento. */
export function leerFranjas(raw: unknown): Franja[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return (v as Array<Record<string, unknown> | null>)
    .filter((f): f is Record<string, unknown> =>
      !!f && typeof f.day === 'number' && f.day >= 0 && f.day <= 6 && !!f.time)
    .map((f) => ({
      day: f.day as number,
      time: String(f.time),
      end: f.end ? String(f.end) : undefined,
      place: f.place ? String(f.place) : undefined,
    }));
}

const minutos = (hhmm: string) => {
  const [h, m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

export interface ProximoEntreno {
  hijoId: string;
  frase: { quien: string; cuando: string; donde: string | null };
}

/**
 * El próximo entreno a partir de la agenda del Calendario (ya sin festivos ni
 * cancelados). `null` = no hay entreno en la agenda: Inicio no muestra franja.
 */
export function fraseEntrenoDeAgenda(items: AgendaItem[], ahora: Date): ProximoEntreno | null {
  const prox = items
    .filter((i) => i.kind === 'training' && (i.allDay ? true : i.start.getTime() >= ahora.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  if (!prox) return null;
  const quien = prox.title.split('·').slice(1).join('·').trim() || prox.title;
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
  const dia = new Date(prox.start.getFullYear(), prox.start.getMonth(), prox.start.getDate()).getTime();
  const enDias = Math.round((dia - hoy) / 86_400_000);
  const { time, period } = timeParts(prox.start);
  const hora = prox.allDay ? '' : ` a las ${time} ${period}`;
  const cuando = enDias === 0 ? `hoy${hora}`
    : enDias === 1 ? `mañana${hora}`
      : `el ${DIAS[prox.start.getDay()]}${hora}`;
  return { hijoId: prox.key, frase: { quien, cuando, donde: null } };
}

/**
 * El entreno más próximo de toda la familia en los próximos 7 días. Uno de hoy
 * cuenta mientras no haya terminado (o, sin hora de fin, hasta su hora de inicio).
 */
export function proximoEntreno(hijos: Hijo[], ahora: Date): ProximoEntreno | null {
  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  let mejor: { hijo: Hijo; f: Franja; enDias: number; orden: number } | null = null;
  for (const hijo of hijos) {
    for (const f of hijo.franjas) {
      let enDias = (f.day - ahora.getDay() + 7) % 7;
      if (enDias === 0) {
        const fin = f.end ? minutos(f.end) : minutos(f.time);
        if (fin <= ahoraMin) enDias = 7;
      }
      const orden = enDias * 1440 + minutos(f.time);
      if (Number.isNaN(orden)) continue;
      if (!mejor || orden < mejor.orden) mejor = { hijo, f, enDias, orden };
    }
  }
  if (!mejor) return null;
  const hora = horaColombia(mejor.f.time);
  const cuando = mejor.enDias === 0
    ? `hoy a las ${hora}`
    : mejor.enDias === 1
      ? `mañana a las ${hora}`
      : `el ${DIAS[mejor.f.day]} a las ${hora}`;
  const donde = mejor.f.place || mejor.hijo.lugar || null;
  return { hijoId: mejor.hijo.id, frase: { quien: primerNombre(mejor.hijo.nombre), cuando, donde } };
}

/**
 * La foto del hijo solo si es una foto de verdad. Los avatares generados
 * (dicebear, la mascota) parecen un muñeco y se confundían con Mapi: en ese
 * caso se muestran las iniciales. El lémur queda solo para Mapi.
 */
export function fotoDeVerdad(url: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  if (/dicebear\.com|\/mapi\/|mascot|ui-avatars\.com/i.test(u)) return null;
  return u;
}

export const iniciales = (nombre: string) =>
  nombre.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';

// ── Dato faltante ────────────────────────────────────────────────────────────

/** El primer hijo sin EPS (dato que la escuela necesita en una emergencia). */
export const hijoSinEps = (hijos: Hijo[]) => hijos.find((h) => !h.eps || !h.eps.trim()) ?? null;
