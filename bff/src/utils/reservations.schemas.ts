// Piezas zod ESTRICTAS compartidas por todos los endpoints de reservas de canchas.
//
// Reglas: z.strictObject en todo (claves desconocidas = 400), UUID e ISO 8601 con zona estrictos,
// números acotados, longitudes máximas y texto libre pasado por sanitizeFreeText.
import { z } from 'zod';
import { sanitizeFreeText } from './sanitize';
import { UUID_RE } from './reservations.shared';

export const LIMITS = {
    notes: 500,
    externalOrg: 200,
    reason: 300,
    name: 120,
    email: 160,
    phone: 20,
    sport: 60,
    participantsMax: 200,
    amountMax: 1_000_000_000,
    durationMinMin: 5,
    durationMinMax: 480,
    batchRows: 200,
} as const;

export const uuid = (label = 'id') => z.string().regex(UUID_RE, `${label} inválido`);
export const isoZoned = z.iso.datetime({ offset: true });
export const dateYmd = z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (YYYY-MM-DD)')
    .refine((s) => {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return y >= 2000 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    }, 'fecha inexistente');
export const timeHm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'hora inválida (HH:MM)');

/** Texto libre opcional: máximo sobre lo recibido, luego saneado. */
export const freeText = (max: number, opts: { keepNewlines?: boolean } = {}) =>
    z.string().max(max * 2) // tope duro de lo crudo (evita procesar megas); el recorte fino lo hace sanitizeFreeText
        .transform((s) => sanitizeFreeText(s, { max, keepNewlines: opts.keepNewlines }));

/** Nombre de persona: saneado, 2–120 caracteres tras sanear. */
export const personName = z.string().max(LIMITS.name * 2)
    .transform((s) => sanitizeFreeText(s, { max: LIMITS.name }))
    .pipe(z.string().min(2, 'nombre demasiado corto').max(LIMITS.name));

export const phoneField = z.string().max(40).regex(/^\+?[0-9 ()\-.]{7,25}$/, 'teléfono inválido');
export const emailField = z.string().max(LIMITS.email).email('correo inválido');

export const rangeRefine = <T extends { starts_at: string; ends_at: string }>(b: T) =>
    new Date(b.ends_at) > new Date(b.starts_at);
export const rangeMsg = { message: 'ends_at debe ser posterior a starts_at', path: ['ends_at'] as PropertyKey[] };

/** Duración máxima de una reserva en horas (corte duro del BFF, además del tope de la cancha). */
export const MAX_RESERVATION_MS = 24 * 3600_000;
export const durationRefine = <T extends { starts_at: string; ends_at: string }>(b: T) =>
    new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime() <= MAX_RESERVATION_MS;
export const durationMsg = { message: 'la duración supera las 24 horas', path: ['ends_at'] as PropertyKey[] };

/** Cuerpo vacío estricto (approve / complete / delete): acepta undefined o {}. */
export const EmptyBody = z.strictObject({});

export const reasonField = freeText(LIMITS.reason);
