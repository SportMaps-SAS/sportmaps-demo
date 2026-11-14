/**
 * Asociación del ID del lector (ZKTeco `zk_pin`) a un deportista desde el ALTA.
 *
 * Dreamers pidió (2026-10-13) reemplazar el campo «Dorsal» del registro por el ID
 * del torniquete: así el deportista queda asociado ANTES de enrolarse en el lector
 * y no hay que pasar después por «asignar usuario» en control de acceso. El ID es la
 * llave que el torniquete reporta en cada marcación; `zk_user_mappings` lo cruza con
 * el deportista (access-adms → resolveMapping).
 *
 * Solo escuelas con `school_settings.registration_zk_pin_enabled = true`.
 * No manda ningún comando al lector (el ID ya existe en él o se enrola después con
 * ese mismo número), igual que POST /access/assign-user.
 */
import { supabase } from '../config/supabase';

export type ZkSubject =
    | { child_id: string }
    | { user_id: string }
    | { unregistered_athlete_id: string };

export class ZkPinError extends Error {
    constructor(public status: number, message: string, public code: string) {
        super(message);
    }
}

/** El lector guarda el PIN como entero; el MB360 acepta hasta 9 dígitos. */
export const ZK_PIN_MIN = 1;
export const ZK_PIN_MAX = 99_999_999;

const subjectColumn = (s: ZkSubject): 'child_id' | 'user_id' | 'unregistered_athlete_id' =>
    'child_id' in s ? 'child_id' : 'user_id' in s ? 'user_id' : 'unregistered_athlete_id';

const subjectId = (s: ZkSubject): string => Object.values(s)[0] as string;

/**
 * ¿La escuela pide el ID del torniquete en el registro? Lectura aparte de
 * school_settings: si la migración no está aplicada, falla cerrado (false) sin
 * romper el alta.
 */
export async function isZkPinEnabled(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('school_settings')
        .select('registration_zk_pin_enabled')
        .eq('school_id', schoolId)
        .maybeSingle();
    if (error) return false;
    return (data as any)?.registration_zk_pin_enabled === true;
}

export function validateZkPin(pin: unknown): number {
    const n = Number(pin);
    if (!Number.isInteger(n) || n < ZK_PIN_MIN || n > ZK_PIN_MAX) {
        throw new ZkPinError(
            400,
            `El ID del torniquete debe ser un número entero entre ${ZK_PIN_MIN} y ${ZK_PIN_MAX}.`,
            'ZK_PIN_INVALID',
        );
    }
    return n;
}

/**
 * Lanza 409 si el ID ya está asociado a OTRA persona de la escuela. Con `subject`
 * (edición) el ID que ya es de esa misma persona no cuenta como conflicto.
 */
export async function assertZkPinAvailable(
    schoolId: string,
    pin: number,
    subject?: ZkSubject,
): Promise<void> {
    const { data: row } = await supabase
        .from('zk_user_mappings')
        .select('child_id, user_id, unregistered_athlete_id')
        .eq('school_id', schoolId)
        .eq('zk_pin', pin)
        .maybeSingle();
    if (!row) return;

    const r = row as any;
    if (subject && r[subjectColumn(subject)] === subjectId(subject)) return;

    let who: string | null = null;
    if (r.child_id) {
        const { data } = await supabase.from('children').select('full_name').eq('id', r.child_id).maybeSingle();
        who = (data as any)?.full_name ?? null;
    } else if (r.unregistered_athlete_id) {
        const { data } = await supabase.from('unregistered_athletes').select('full_name').eq('id', r.unregistered_athlete_id).maybeSingle();
        who = (data as any)?.full_name ?? null;
    } else if (r.user_id) {
        const { data } = await supabase.from('profiles').select('full_name').eq('id', r.user_id).maybeSingle();
        who = (data as any)?.full_name ?? null;
    }
    throw new ZkPinError(
        409,
        `El ID ${pin} ya está asociado a ${who ?? 'otra persona'}. Usa otro ID o libéralo primero.`,
        'ZK_PIN_IN_USE',
    );
}

/**
 * Deja al deportista con ESE ID y ninguno otro (una persona = un ID). Si ya tenía
 * otro, se reemplaza. chk_zk_mapping_subject_exclusivity exige exactamente una de
 * las tres columnas de identidad.
 */
export async function assignZkPin(schoolId: string, pin: number, subject: ZkSubject): Promise<void> {
    const col = subjectColumn(subject);
    const id  = subjectId(subject);

    // Un ID previo de la misma persona se retira (cambio de ID desde la edición).
    const { error: delErr } = await supabase
        .from('zk_user_mappings')
        .delete()
        .eq('school_id', schoolId)
        .eq(col, id)
        .neq('zk_pin', pin);
    if (delErr) throw new Error(`No se pudo liberar el ID anterior: ${delErr.message}`);

    const { error } = await supabase.from('zk_user_mappings').upsert(
        {
            school_id: schoolId,
            zk_pin: pin,
            user_id: col === 'user_id' ? id : null,
            unregistered_athlete_id: col === 'unregistered_athlete_id' ? id : null,
            child_id: col === 'child_id' ? id : null,
        },
        { onConflict: 'school_id,zk_pin' },
    );
    if (error) throw new Error(`No se pudo asociar el ID del torniquete: ${error.message}`);

    // Import perezoso: access-adms arrastra el router entero y este servicio también
    // lo cargan los tests de las rutas de alta, que solo mockean supabase.
    const { invalidateMappingCache, reprocessPinEventsForHourBank } = await import('../routes/access-adms');
    invalidateMappingCache(pin);
    // Marcaciones de este ID que llegaron antes de asociarlo (nunca lanza).
    await reprocessPinEventsForHourBank(schoolId, pin);
}

/**
 * Validación previa para el alta: se llama ANTES de crear al deportista, así un ID
 * inválido, repetido o de una escuela que no lo usa corta sin dejar nada a medias.
 * Devuelve el ID validado o null si no se mandó.
 */
export async function prepareZkPinForSignup(
    schoolId: string,
    raw: unknown,
    subject?: ZkSubject,
): Promise<number | null> {
    if (raw === undefined || raw === null || raw === '') return null;
    if (!(await isZkPinEnabled(schoolId))) {
        throw new ZkPinError(
            400,
            'Esta escuela no registra el ID del torniquete en el alta.',
            'ZK_PIN_NOT_ENABLED',
        );
    }
    const pin = validateZkPin(raw);
    await assertZkPinAvailable(schoolId, pin, subject);
    return pin;
}
