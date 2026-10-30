/**
 * grupos-por-edad.service — qué grupo de la escuela le corresponde a una edad.
 *
 * POR QUÉ EXISTE (2026-10-07)
 * Ningún equipo de Dynasty ni de Besser tiene `age_min`/`age_max` ni
 * `category_id` cargados, y ninguna de las dos tiene `school_categories`. El
 * bot no podía contestar «¿qué grupo le corresponde a mi hija de 12?» ni
 * «¿desde qué edad reciben?», y la clase de cortesía preguntaba la edad para
 * después no poder filtrar con ella.
 *
 * DE DÓNDE SALE EL RANGO DE CADA GRUPO, en este orden (gana el primero que hay):
 *   1. `teams.age_min` / `teams.age_max` — lo que la escuela cargó. Confianza alta.
 *   2. La categoría vinculada (`teams.category_id` → `school_categories`:
 *      age_min/age_max o birth_year_min/max). Confianza alta.
 *   3. La DISTRIBUCIÓN REAL de edades de los atletas ACTIVOS del grupo
 *      (enrollments activos → children / unregistered_athletes / profiles),
 *      percentiles 5–95, con al menos MIN_MUESTRA fechas de nacimiento. Es
 *      un dato medido, no una suposición: «aquí entrenan hoy niñas de 12 a 15».
 *      Confianza media (≥ 20 con fecha) o baja.
 *   4. El NOMBRE, solo cuando lo dice explícito: un año de nacimiento
 *      («2011 - ARRAYANES» → 14–15 años) o «Seniors/Adultos/Máster» (18+).
 *      «Infantil», «Menores», «Sub-15» NO se traducen a edades: la convención
 *      cambia por federación y por año (regla de whatsapp-info-escuela). Para
 *      eso está la propuesta de SQL que la escuela confirma
 *      (docs/migraciones-para-aplicar-2026-10-07/PROPUESTA_edades_grupos_dynasty_besser.sql).
 *
 * GÉNERO: el nombre manda («FEMENINO»); después la categoría (`rama`); después
 * los atletas activos, solo si ≥ 95 % de los que tienen género cargado es uno
 * (con ≥ 5 conocidos). Si no, mixto o desconocido.
 *
 * Se cachea por escuela 1 h: lo usan la clase de cortesía y el bot en cada
 * turno, y la distribución no cambia de un mensaje a otro.
 *
 * EMBUDO DEL INTERESADO (Monster, 2026-10-30) — `elegirGrupoEmbudo`
 * El embudo pregunta la sede y el AÑO de nacimiento. Ahí no se pasa por la
 * edad (±1 año de error): el año se compara con `birth_year_min/max` de la
 * categoría, exacto. Solo cuentan los equipos con `teams.recibe_clase_prueba`
 * (columna de la migración M1; sin ella, todos). Sin nivel: en Monster la
 * clase de prueba va siempre a un grupo de Proyección, y eso se marca con
 * `recibe_clase_prueba`, no con una regla. `elegirGrupo` (el de la edad) no
 * cambió.
 *
 * DIRECCIÓN DE LA CANCHA — `direccionDeLugar`
 * Coincidencia EXACTA con `facilities.name` (o el lugar nombra la cancha
 * entera). La vieja `direccionDeSede` compara por «contiene» y confunde
 * «Pinar» con «Parque Pinar de Suba 2».
 */

import { supabase } from '../config/supabase';

export type Genero = 'f' | 'm' | 'mixto';
export type FuenteEdad = 'equipo' | 'categoria' | 'atletas' | 'nombre';
export type Nivel = 'iniciacion' | 'intermedio' | 'seleccion' | 'adultos';
export type Confianza = 'alta' | 'media' | 'baja';

export interface RangoGrupo {
    teamId: string;
    nombre: string;
    edadMin: number | null;
    edadMax: number | null;
    /** Edad mediana de los atletas activos (null si no hay muestra). */
    mediana: number | null;
    fuenteEdad: FuenteEdad | null;
    genero: Genero | null;
    /** El género lo dice el nombre o la categoría (no se infirió de los atletas). */
    generoExplicito: boolean;
    /** El nombre o la categoría dicen que es de adultos. */
    adultos: boolean;
    nivel: Nivel | null;
    /** «lunes y miércoles 6:30–8:30 p. m.» (de teams.schedule). */
    horario: string | null;
    admiteNuevos: boolean;
    /** Atletas activos con fecha de nacimiento. */
    muestra: number;
    confianza: Confianza;
    // ── Embudo del interesado (2026-10-30). Opcionales: los arma construirRangos. ──
    /** Sede del equipo (`teams.branch_id`, o la de su categoría). */
    branchId?: string | null;
    /** Años de nacimiento que recibe (`school_categories.birth_year_min/max`). null = sin límite de ese lado. */
    anioMin?: number | null;
    anioMax?: number | null;
    /** Entrenadores: `team_coaches.coach_id` ∪ `teams.coach_id` (ids de `school_staff`, NO de profiles). */
    coachIds?: string[];
    /** Sus nombres (`school_staff.full_name`, solo staff activo y con nombre). */
    coachNombres?: string[];
    /** `teams.recibe_clase_prueba` (mig. M1). Sin la columna = true. */
    recibeClasePrueba?: boolean;
    /** `teams.facility_id`: la cancha del equipo (para la dirección cuando el horario no dice el lugar). */
    facilityId?: string | null;
}

/** Lo que se sabe del deportista (compatible con PerfilAtleta de la cortesía). */
export interface PerfilEdad {
    edad?: number | null;
    genero?: 'f' | 'm' | null;
    adulto?: boolean;
}

export interface EquipoCrudo {
    id: string;
    name: string | null;
    age_min?: number | null;
    age_max?: number | null;
    schedule?: unknown;
    admite_nuevos?: boolean | null;
    active?: boolean | null;
    status?: string | null;
    branch_id?: string | null;
    facility_id?: string | null;
    coach_id?: string | null;
    /** Mig. M1; ausente o null = recibe (como hoy). */
    recibe_clase_prueba?: boolean | null;
    /** team_coaches ∪ coach_id, ya resueltos por quien lee (si no, solo coach_id). */
    coachIds?: string[];
    coachNombres?: string[];
    categoria?: {
        age_min?: number | null; age_max?: number | null;
        birth_year_min?: number | null; birth_year_max?: number | null;
        rama?: string | null;
        branch_id?: string | null;
    } | null;
}

export interface AtletaCrudo {
    teamId: string;
    fechaNacimiento: string | null;
    genero: string | null;
}

export const MIN_MUESTRA = 5;
export const TTL_CACHE_MS = 60 * 60 * 1000;
const EDAD_MIN_VALIDA = 4;   // fechas de nacimiento de este año = error de carga
const EDAD_MAX_VALIDA = 90;

// ─── Texto (puro) ──────────────────────────────────────────────────────────

export function normalizarTexto(t: string | null | undefined): string {
    return String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function tituloGrupo(nombre: string): string {
    return nombre.trim().toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
}

export function generoDeNombre(nombre: string): 'f' | 'm' | null {
    const n = normalizarTexto(nombre);
    if (/\b(femenino|femenina|femeninas|damas|mujeres|chicas)\b/.test(n)) return 'f';
    if (/\b(masculino|masculina|masculinos|varones|hombres|caballeros)\b/.test(n)) return 'm';
    return null;
}

export function esNombreDeAdultos(nombre: string): boolean {
    return /\b(senior|seniors|adulto|adultos|adultas|master|masters|veteranos|veteranas)\b/.test(normalizarTexto(nombre));
}

/** Años de nacimiento escritos en el nombre («2011 - ARRAYANES», «2013-2014»). */
export function aniosEnNombre(nombre: string): number[] {
    return [...normalizarTexto(nombre).matchAll(/\b(19[5-9]\d|20[0-2]\d)\b/g)].map((m) => Number(m[1]));
}

export function nivelDeNombre(nombre: string): Nivel | null {
    const n = normalizarTexto(nombre);
    if (esNombreDeAdultos(nombre)) return 'adultos';
    if (/\b(seleccion|competencia|elite|proyeccion|profundizacion|liga)\b/.test(n)) return 'seleccion';
    if (/\b(intermedio|intermedia)\b/.test(n)) return 'intermedio';
    if (/\b(iniciacion|minivoley|minivolley|benjamin|benjamines|semillero|escuela|baby)\b/.test(n)) return 'iniciacion';
    return null;
}

function generoDeRama(rama: string | null | undefined): Genero | null {
    const n = normalizarTexto(rama);
    if (n.startsWith('fem')) return 'f';
    if (n.startsWith('mas')) return 'm';
    if (n.startsWith('mix')) return 'mixto';
    return null;
}

function generoDeAtleta(g: string | null | undefined): 'f' | 'm' | null {
    const n = normalizarTexto(g);
    if (['f', 'female', 'femenino', 'mujer'].includes(n)) return 'f';
    if (['m', 'male', 'masculino', 'hombre'].includes(n)) return 'm';
    return null;
}

/** Hoy en Bogotá (UTC−5, sin horario de verano). */
export function hoyBogota(ahora: Date): { y: number; m: number; d: number } {
    const b = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
    return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
}

export function edadEn(fechaNacimiento: string | null | undefined, hoy: { y: number; m: number; d: number }): number | null {
    const m = String(fechaNacimiento ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [y, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    let edad = hoy.y - y;
    if (hoy.m < mes || (hoy.m === mes && hoy.d < dia)) edad--;
    return edad;
}

/** Percentil por rango más cercano sobre un arreglo ORDENADO. */
export function percentil(ordenados: number[], p: number): number {
    const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil(p * ordenados.length) - 1));
    return ordenados[i];
}

// ─── Horario compacto ──────────────────────────────────────────────────────

const DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ORDEN_SEMANA = (d: number) => (d === 0 ? 7 : d);

function partesHora(h: string): { t: string; pm: boolean } | null {
    const m = String(h ?? '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = Number(m[1]);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return { t: m[2] === '00' ? String(h12) : `${h12}:${m[2]}`, pm: hh >= 12 };
}

/** «18:30»–«20:30» → «6:30–8:30 p. m.»; «11:00»–«13:00» → «11 a. m.–1 p. m.». */
export function rangoHorario(inicio: string, fin?: string | null): string {
    const a = partesHora(inicio);
    if (!a) return inicio;
    const sufijo = (pm: boolean) => (pm ? 'p. m.' : 'a. m.');
    const b = fin ? partesHora(fin) : null;
    if (!b) return `${a.t} ${sufijo(a.pm)}`;
    if (a.pm === b.pm) return `${a.t}–${b.t} ${sufijo(b.pm)}`;
    return `${a.t} ${sufijo(a.pm)}–${b.t} ${sufijo(b.pm)}`;
}

function listaDias(dias: number[]): string {
    const n = dias.map((d) => DIA[d]);
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}

/**
 * teams.schedule → «lunes y miércoles 6:30–8:30 p. m.; sábado y domingo 11 a. m.–1 p. m.».
 * Junta los días con la misma hora. Con subgrupos («Origen», «Evolución»)
 * los separa: «Origen: …; | Evolución: …».
 */
export function horarioCompacto(raw: unknown): string | null {
    let filas: any[];
    try { filas = typeof raw === 'string' ? JSON.parse(raw) : (raw as any[]); } catch { return null; }
    if (!Array.isArray(filas)) return null;
    const util = filas.filter((f) => f && typeof f.day === 'number' && f.day >= 0 && f.day <= 6 && f.time);
    if (!util.length) return null;
    const subgrupos = [...new Set(util.map((f) => (f.group ? String(f.group) : '')))];
    const bloque = (fs: any[]) => {
        const porHora = new Map<string, number[]>();
        for (const f of [...fs].sort((x, y) => ORDEN_SEMANA(x.day) - ORDEN_SEMANA(y.day))) {
            const k = rangoHorario(String(f.time), f.end ? String(f.end) : null);
            if (!porHora.has(k)) porHora.set(k, []);
            if (!porHora.get(k)!.includes(f.day)) porHora.get(k)!.push(f.day);
        }
        return [...porHora.entries()].map(([h, dias]) => `${listaDias(dias)} ${h}`).join('; ');
    };
    if (subgrupos.length > 1) {
        return subgrupos.map((g) => `${g || 'General'}: ${bloque(util.filter((f) => (f.group ? String(f.group) : '') === g))}`)
            .join(' | ');
    }
    return bloque(util);
}

// ─── Construcción del mapa (puro) ──────────────────────────────────────────

const MARCADO_NO_USAR = /\bno\s+usar\b/i;

export function construirRangos(equipos: EquipoCrudo[], atletas: AtletaCrudo[], ahora: Date = new Date()): RangoGrupo[] {
    const hoy = hoyBogota(ahora);
    const porEquipo = new Map<string, AtletaCrudo[]>();
    for (const a of atletas) {
        if (!a.teamId) continue;
        if (!porEquipo.has(a.teamId)) porEquipo.set(a.teamId, []);
        porEquipo.get(a.teamId)!.push(a);
    }

    return equipos
        .filter((t) => t.active !== false && t.status !== 'inactive' && !MARCADO_NO_USAR.test(String(t.name ?? '')))
        .filter((t) => String(t.name ?? '').trim())
        .map((t): RangoGrupo => {
            const nombre = String(t.name).trim();
            const delEquipo = porEquipo.get(t.id) ?? [];
            const edades = delEquipo.map((a) => edadEn(a.fechaNacimiento, hoy))
                .filter((e): e is number => e != null && e >= EDAD_MIN_VALIDA && e <= EDAD_MAX_VALIDA)
                .sort((a, b) => a - b);
            const muestra = edades.length;
            const mediana = muestra ? percentil(edades, 0.5) : null;
            const adultosNombre = esNombreDeAdultos(nombre);

            // Edad: equipo → categoría → atletas → nombre.
            let edadMin: number | null = null;
            let edadMax: number | null = null;
            let fuenteEdad: FuenteEdad | null = null;
            let confianza: Confianza = 'baja';
            const cat = t.categoria ?? null;
            if (t.age_min != null || t.age_max != null) {
                edadMin = t.age_min ?? null; edadMax = t.age_max ?? null; fuenteEdad = 'equipo'; confianza = 'alta';
            } else if (cat && (cat.age_min != null || cat.age_max != null)) {
                edadMin = cat.age_min ?? null; edadMax = cat.age_max ?? null; fuenteEdad = 'categoria'; confianza = 'alta';
            } else if (cat && (cat.birth_year_min != null || cat.birth_year_max != null)) {
                // Por año de nacimiento: en el año cumple (hoy.y − año); hoy tiene eso o uno menos.
                edadMin = cat.birth_year_max != null ? hoy.y - cat.birth_year_max - 1 : null;
                edadMax = cat.birth_year_min != null ? hoy.y - cat.birth_year_min : null;
                fuenteEdad = 'categoria'; confianza = 'alta';
            } else if (muestra >= MIN_MUESTRA) {
                edadMin = percentil(edades, 0.05);
                edadMax = percentil(edades, 0.95);
                // Grupo de adultos: no tiene techo (un señor de 60 no queda «fuera»).
                if (adultosNombre || (mediana != null && mediana >= 25)) edadMax = null;
                fuenteEdad = 'atletas';
                confianza = muestra >= 20 ? 'media' : 'baja';
            } else {
                const anios = aniosEnNombre(nombre);
                if (anios.length) {
                    edadMin = hoy.y - Math.max(...anios) - 1;
                    edadMax = hoy.y - Math.min(...anios);
                    fuenteEdad = 'nombre'; confianza = 'media';
                } else if (adultosNombre) {
                    edadMin = 18; fuenteEdad = 'nombre'; confianza = 'media';
                }
            }

            // Género: nombre → categoría → atletas.
            let genero: Genero | null = generoDeNombre(nombre);
            let generoExplicito = genero !== null;
            if (!genero && cat?.rama) {
                genero = generoDeRama(cat.rama);
                generoExplicito = genero !== null;
            }
            if (!genero) {
                const gs = delEquipo.map((a) => generoDeAtleta(a.genero)).filter(Boolean) as ('f' | 'm')[];
                const f = gs.filter((g) => g === 'f').length;
                const m = gs.length - f;
                if (gs.length >= MIN_MUESTRA) {
                    genero = f / gs.length >= 0.95 ? 'f' : m / gs.length >= 0.95 ? 'm' : 'mixto';
                }
            }

            return {
                teamId: t.id, nombre, edadMin, edadMax, mediana, fuenteEdad, genero, generoExplicito,
                adultos: adultosNombre, nivel: nivelDeNombre(nombre), horario: horarioCompacto(t.schedule),
                admiteNuevos: t.admite_nuevos !== false, muestra, confianza,
                branchId: t.branch_id ?? cat?.branch_id ?? null,
                anioMin: cat?.birth_year_min ?? null,
                anioMax: cat?.birth_year_max ?? null,
                coachIds: t.coachIds ?? (t.coach_id ? [t.coach_id] : []),
                coachNombres: t.coachNombres ?? [],
                recibeClasePrueba: t.recibe_clase_prueba !== false,
                facilityId: t.facility_id ?? null,
            };
        });
}

// ─── Elegir el grupo (puro) ────────────────────────────────────────────────

export interface EleccionGrupo {
    principal: RangoGrupo | null;
    /** Sin género dicho y hay grupo femenino Y masculino para esa edad. */
    porGenero: { f: RangoGrupo; m: RangoGrupo } | null;
    /** Ningún grupo la incluye: el principal es el más cercano (a 1 año). */
    cercano: boolean;
}

const PRIORIDAD_FUENTE: Record<FuenteEdad, number> = { equipo: 0, categoria: 0, atletas: 1, nombre: 2 };
const tieneRango = (r: RangoGrupo) => r.edadMin != null || r.edadMax != null;

function distanciaFuera(r: RangoGrupo, edad: number): number {
    if (r.edadMin != null && edad < r.edadMin) return r.edadMin - edad;
    if (r.edadMax != null && edad > r.edadMax) return edad - r.edadMax;
    return 0;
}

export function elegirGrupo(rangos: RangoGrupo[], perfil: PerfilEdad | null | undefined): EleccionGrupo {
    const vacio: EleccionGrupo = { principal: null, porGenero: null, cercano: false };
    if (!perfil) return vacio;
    const edad = typeof perfil.edad === 'number' ? perfil.edad : null;
    const adulto = !!perfil.adulto || (edad != null && edad >= 18);
    if (edad == null && !adulto) return vacio;

    let cands = rangos.filter((r) => r.admiteNuevos && (tieneRango(r) || r.adultos));
    if (perfil.genero) {
        const otro = perfil.genero === 'f' ? 'm' : 'f';
        cands = cands.filter((r) => r.genero !== otro);
    }
    if (!adulto) cands = cands.filter((r) => !r.adultos || (edad != null && tieneRango(r) && distanciaFuera(r, edad) === 0));

    const contiene = (r: RangoGrupo) => {
        if (edad != null) return tieneRango(r) ? distanciaFuera(r, edad) === 0 : r.adultos && edad >= 18;
        return r.adultos || (r.edadMin != null && r.edadMin >= 17);
    };
    const centro = (r: RangoGrupo) => r.mediana
        ?? (r.edadMin != null && r.edadMax != null ? (r.edadMin + r.edadMax) / 2 : (r.edadMin ?? r.edadMax ?? 0));
    const ancho = (r: RangoGrupo) => (r.edadMin != null && r.edadMax != null ? r.edadMax - r.edadMin : 99);
    const clave = (r: RangoGrupo): number[] => [
        perfil.genero && r.generoExplicito && r.genero === perfil.genero ? 0 : 1,
        adulto && r.adultos ? 0 : 1,
        PRIORIDAD_FUENTE[r.fuenteEdad ?? 'nombre'],
        edad != null ? Math.abs(edad - centro(r)) : 0,
        ancho(r),
    ];
    const ordenar = (xs: RangoGrupo[]) => [...xs].sort((a, b) => {
        const ka = clave(a); const kb = clave(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return a.nombre.localeCompare(b.nombre);
    });

    const dentro = ordenar(cands.filter(contiene));
    if (dentro.length) {
        if (!perfil.genero && !adulto) {
            const f = dentro.find((r) => r.generoExplicito && r.genero === 'f');
            const m = dentro.find((r) => r.generoExplicito && r.genero === 'm');
            if (f && m) return { principal: dentro[0], porGenero: { f, m }, cercano: false };
        }
        return { principal: dentro[0], porGenero: null, cercano: false };
    }
    if (edad != null) {
        const cerca = ordenar(cands.filter((r) => tieneRango(r) && distanciaFuera(r, edad) === 1));
        if (cerca.length) return { principal: cerca[0], porGenero: null, cercano: true };
    }
    return vacio;
}

// ─── Grupo del embudo del interesado (puro) ────────────────────────────────

export interface PerfilEmbudo {
    /** Sede elegida (`school_branches.id`). null/ausente = cualquier sede. */
    branchId?: string | null;
    /** Año de nacimiento (el embudo acepta «2011» solo). */
    anio: number | null | undefined;
    genero?: 'f' | 'm' | null;
}

export interface EleccionEmbudo {
    /** El grupo que le corresponde: el más específico. null = ninguno (nunca se inventa). */
    principal: RangoGrupo | null;
    /** Todos los que lo reciben en esa sede, del más específico al más general. */
    candidatos: RangoGrupo[];
    /** Sin grupo en la sede pedida: el mejor de OTRA sede (para «Ver Sede X»). */
    otraSede: RangoGrupo | null;
    /** 'sin_anio' = no hay año; 'sin_grupo' = ningún grupo con clase de prueba lo recibe. */
    motivo: 'sin_anio' | 'sin_grupo' | null;
}

/**
 * Grupo de la clase de prueba para el embudo: sede → año exacto en
 * `birth_year_*` → rama. Solo equipos que reciben clase de prueba y admiten
 * nuevos (el generador tampoco crea franjas de los que no admiten). Mixto
 * acepta las dos ramas; un equipo sin rama conocida también, pero después.
 * Sin nivel (Monster: la clase de prueba siempre en Proyección). Un equipo sin
 * años cargados NO se elige: el año no se traduce a edad. Pura.
 */
export function elegirGrupoEmbudo(rangos: RangoGrupo[], perfil: PerfilEmbudo): EleccionEmbudo {
    const anio = typeof perfil?.anio === 'number' && Number.isInteger(perfil.anio) ? perfil.anio : null;
    if (anio == null) return { principal: null, candidatos: [], otraSede: null, motivo: 'sin_anio' };
    const genero = perfil.genero === 'f' || perfil.genero === 'm' ? perfil.genero : null;

    const porRama = rangos
        .filter((r) => r.recibeClasePrueba !== false && r.admiteNuevos)
        .filter((r) => (r.anioMin != null || r.anioMax != null)
            && (r.anioMin == null || anio >= r.anioMin) && (r.anioMax == null || anio <= r.anioMax))
        .filter((r) => !genero || r.genero == null || r.genero === 'mixto' || r.genero === genero);

    const claveRama = (r: RangoGrupo) => (genero
        ? (r.genero === genero ? 0 : r.genero === 'mixto' ? 1 : 2)
        : (r.genero === 'mixto' ? 0 : r.genero == null ? 1 : 2));
    const anchoAnios = (r: RangoGrupo) => (r.anioMin != null && r.anioMax != null ? r.anioMax - r.anioMin : 999);
    const ordenar = (xs: RangoGrupo[]) => [...xs].sort((a, b) =>
        claveRama(a) - claveRama(b) || anchoAnios(a) - anchoAnios(b) || a.nombre.localeCompare(b.nombre));

    const sede = perfil.branchId ?? null;
    const candidatos = ordenar(sede ? porRama.filter((r) => r.branchId === sede) : porRama);
    const otraSede = !candidatos.length && sede
        ? ordenar(porRama.filter((r) => r.branchId && r.branchId !== sede))[0] ?? null
        : null;
    return { principal: candidatos[0] ?? null, candidatos, otraSede, motivo: candidatos.length ? null : 'sin_grupo' };
}

// ─── Dirección de la cancha (pura) ─────────────────────────────────────────

/** Una cancha de la escuela (`facilities`), con lo que la migración M1 le agrega. */
export interface LugarDeEscuela {
    id: string;
    nombre: string;
    branchId?: string | null;
    direccion?: string | null;
    mapsUrl?: string | null;
    indicaciones?: string | null;
}

export interface DireccionDeLugar {
    lugarId: string;
    /** Nombre de la cancha tal como la escribió la escuela. */
    nombre: string;
    direccion: string | null;
    mapsUrl: string | null;
    /** Por dónde se entra, qué pasa si llueve (`facilities.indicaciones`). */
    indicaciones: string | null;
}

const limpio = (v: unknown) => String(v ?? '').trim() || null;

/**
 * La cancha que nombra el lugar de una franja (`teams.schedule[].place`).
 *   1. Nombre IGUAL (sin tildes ni mayúsculas): «Pinar» es «Pinar», no
 *      «Parque Pinar de Suba 2».
 *   2. El lugar contiene el nombre ENTERO de una cancha («Cancha Pinar 2 -
 *      sintética» → «Pinar 2»): la más larga, si no empata.
 * Nunca al revés (que el nombre de la cancha contenga al lugar): eso es lo que
 * confundía «Pinar» con «Pinar 2». Sin coincidencia → null. Pura.
 */
export function direccionDeLugar(lugar: string | null | undefined, lugares: LugarDeEscuela[]): DireccionDeLugar | null {
    const n = normalizarTexto(lugar);
    if (!n) return null;
    const salida = (l: LugarDeEscuela): DireccionDeLugar => ({
        lugarId: l.id, nombre: String(l.nombre).trim(),
        direccion: limpio(l.direccion), mapsUrl: limpio(l.mapsUrl), indicaciones: limpio(l.indicaciones),
    });
    const iguales = lugares.filter((l) => normalizarTexto(l.nombre) === n);
    if (iguales.length) {
        // Dos canchas con el mismo nombre y datos distintos: no se adivina cuál.
        const firma = (l: LugarDeEscuela) => [limpio(l.direccion), limpio(l.mapsUrl), limpio(l.indicaciones)].join('|');
        return iguales.every((l) => firma(l) === firma(iguales[0])) ? salida(iguales[0]) : null;
    }
    const contenidas = lugares
        .map((l) => ({ l, m: normalizarTexto(l.nombre) }))
        .filter(({ m }) => m.length >= 4 && ` ${n} `.includes(` ${m} `))
        .sort((a, b) => b.m.length - a.m.length);
    if (!contenidas.length) return null;
    if (contenidas.length > 1 && contenidas[1].m.length === contenidas[0].m.length) return null;
    return salida(contenidas[0].l);
}

// ─── Respuestas (puras) ────────────────────────────────────────────────────

function conHorario(r: RangoGrupo, aclaracion = ''): string {
    return `*${tituloGrupo(r.nombre)}*${aclaracion}${r.horario ? ` (${r.horario})` : ''}`;
}

const confirmaEscuela = (r: RangoGrupo) => r.fuenteEdad === 'equipo' || r.fuenteEdad === 'categoria'
    ? '' : ' La escuela te lo confirma en la primera clase.';

/** «Para 12 años le corresponde *Infantil Femenino* (lunes y miércoles 6:30–8:30 p. m.).» */
export function textoGrupoParaEdad(e: EleccionGrupo, perfil: PerfilEdad): string | null {
    if (!e.principal) return null;
    const edad = typeof perfil.edad === 'number' ? perfil.edad : null;
    if (edad == null) return `El grupo para adultos es ${conHorario(e.principal)}.` + confirmaEscuela(e.principal);
    const para = `Para ${edad} años`;
    if (e.porGenero) {
        return `${para}: ${conHorario(e.porGenero.f)} si es niña, o ${conHorario(e.porGenero.m)} si es niño.`
            + confirmaEscuela(e.porGenero.f);
    }
    if (e.cercano && edad != null) {
        const desde = e.principal.edadMin != null && edad < e.principal.edadMin
            ? `desde los ${e.principal.edadMin}` : `hasta los ${e.principal.edadMax}`;
        return `${para} el grupo más cercano es ${conHorario(e.principal)}, que hoy recibe ${desde}. ` +
            'La escuela te confirma si puede entrar.';
    }
    return `${para} le corresponde ${conHorario(e.principal, e.principal.adultos ? ', el grupo para adultos' : '')}.`
        + confirmaEscuela(e.principal);
}

/** «¿Desde qué edad reciben?» → la edad más baja de los grupos abiertos (+ adultos). */
export function textoDesdeQueEdad(rangos: RangoGrupo[]): string | null {
    const abiertos = rangos.filter((r) => r.admiteNuevos);
    const conMin = abiertos.filter((r) => r.edadMin != null && !r.adultos)
        .sort((a, b) => a.edadMin! - b.edadMin! || a.nombre.localeCompare(b.nombre));
    if (!conMin.length) return null;
    const menor = conMin[0];
    const deAdultos = abiertos.find((r) => r.adultos);
    const algunoInferido = [menor, deAdultos].some((r) => r && r.fuenteEdad !== 'equipo' && r.fuenteEdad !== 'categoria');
    return `La escuela recibe desde los *${menor.edadMin} años* (${conHorario(menor)})` +
        (deAdultos ? ` y tiene grupo para adultos (*${tituloGrupo(deAdultos.nombre)}*)` : '') + '. ' +
        'Si me dices la edad, te digo qué grupo le corresponde.' +
        (algunoInferido ? ' La escuela te confirma el grupo en la primera clase.' : '');
}

/**
 * ¿Pregunta por el grupo de una edad o por las edades que reciben?
 *   'desde' — «¿desde qué edad reciben?», «¿qué edades manejan?», «edad mínima».
 *   'grupo' — «¿qué grupo le corresponde a mi hija de 12?», «en qué categoría
 *             quedaría un niño de 8», «mi hija tiene 14, ¿en qué grupo iría?».
 * «¿En qué grupo va mi hijo?» (sin edad) NO: es de una familia que pregunta por
 * su inscripción, y eso lo contesta el bot general.
 */
export function preguntaGrupoPorEdad(texto: string | null | undefined): 'grupo' | 'desde' | null {
    const n = normalizarTexto(texto);
    if (!n) return null;
    const conEdad = /\b\d{1,2} ?(anos|ano|anitos)\b/.test(n)
        || /\b(hija|hijo|nina|nino|nena|nene|sobrina|sobrino|nieta|nieto|hijita|hijito|chico|chica) (de|tiene) \d{1,2}\b/.test(n)
        || /\b(tiene|tengo) \d{1,2}\b/.test(n);
    const nombraGrupo = /\b(grupo|grupos|categoria|categorias|equipo|nivel)\b/.test(n);
    if (nombraGrupo && (conEdad || /\b(corresponde|corresponderia|quedaria|iria|entraria|toca|tocaria|seria|ubicarian|meterian)\b/.test(n))) {
        return 'grupo';
    }
    if (/\b(reciben|aceptan|admiten|hay clases para|tienen clases para) (a )?(ninos|ninas|bebes|chicos|chicas|nenes)? ?de \d{1,2}\b/.test(n)) return 'grupo';
    if (/\b(desde|a partir de) (que|cuantos|cual) (edad|anos)\b|\bedad minima\b|\bque edades\b|\bhasta que edad\b|\bde que edad(es)?\b|\b(rango|rangos) de edad/.test(n)) {
        return 'desde';
    }
    return null;
}

// ─── Supabase (cacheado) ───────────────────────────────────────────────────

const cache = new Map<string, { en: number; rangos: RangoGrupo[] }>();
const cacheLugares = new Map<string, { en: number; lugares: LugarDeEscuela[] }>();
export const TTL_LUGARES_MS = 10 * 60 * 1000;

export function limpiarCacheGrupos(): void {
    cache.clear();
    cacheLugares.clear();
}

/** ¿El error es por una columna que todavía no existe (migración sin aplicar)? */
function faltaColumna(error: any, columna: string): boolean {
    return !!error && (error.code === '42703' || new RegExp(columna).test(String(error.message ?? '')));
}

/**
 * Entrenadores de cada equipo (team_coaches ∪ teams.coach_id) con su nombre.
 * Esos coach_id son ids de `school_staff` (no de profiles): el nombre sale de la
 * ficha del staff activo, igual que `profesDeStaff` de la agenda. Dos lecturas
 * por lote, sin N+1. Nunca lanza: si falla, solo coach_id.
 */
async function entrenadoresDeEquipos(equipos: any[]): Promise<Map<string, { ids: string[]; nombres: string[] }>> {
    const porEquipo = new Map<string, Set<string>>();
    for (const t of equipos) porEquipo.set(String(t.id), new Set(t.coach_id ? [String(t.coach_id)] : []));
    try {
        const ids = [...porEquipo.keys()];
        const filas = await porLotes(ids, async (lote) => {
            const { data } = await supabase.from('team_coaches').select('team_id, coach_id').in('team_id', lote);
            return (data ?? []) as any[];
        });
        for (const f of filas) if (f?.team_id && f?.coach_id) porEquipo.get(String(f.team_id))?.add(String(f.coach_id));
    } catch { /* solo coach_id */ }
    const todos = [...new Set([...porEquipo.values()].flatMap((s) => [...s]))];
    const nombres = new Map<string, string>();
    try {
        const staff = await porLotes(todos, async (lote) => {
            const { data } = await supabase.from('school_staff').select('id, full_name, status').in('id', lote);
            return (data ?? []) as any[];
        });
        for (const p of staff) {
            if (p?.id && (p.status == null || p.status === 'active') && String(p.full_name ?? '').trim()) {
                nombres.set(String(p.id), String(p.full_name).trim());
            }
        }
    } catch { /* sin nombres */ }
    return new Map([...porEquipo.entries()].map(([teamId, s]) => {
        const ids = [...s];
        return [teamId, { ids, nombres: ids.map((id) => nombres.get(id)).filter((x): x is string => !!x) }];
    }));
}

/**
 * Canchas de la escuela con dirección, enlace de Maps e indicaciones (las tres
 * columnas llegan con la migración M1; sin ella, solo id y nombre). Cacheado
 * 10 min. Nunca lanza.
 */
export async function lugaresDeEscuela(schoolId: string, ahora: number = Date.now()): Promise<LugarDeEscuela[]> {
    const c = cacheLugares.get(schoolId);
    if (c && ahora - c.en < TTL_LUGARES_MS) return c.lugares;
    try {
        let r: any = await supabase.from('facilities')
            .select('id, name, branch_id, address, maps_url, indicaciones').eq('school_id', schoolId).limit(200);
        if (r?.error && (faltaColumna(r.error, 'address') || faltaColumna(r.error, 'maps_url') || faltaColumna(r.error, 'indicaciones'))) {
            r = await supabase.from('facilities').select('id, name, branch_id').eq('school_id', schoolId).limit(200);
        }
        if (!r || r.error || !Array.isArray(r.data)) return [];
        const lugares: LugarDeEscuela[] = (r.data as any[])
            .filter((f) => f?.id && String(f.name ?? '').trim())
            .map((f) => ({
                id: String(f.id), nombre: String(f.name).trim(), branchId: f.branch_id ?? null,
                direccion: limpio(f.address), mapsUrl: limpio(f.maps_url), indicaciones: limpio(f.indicaciones),
            }));
        cacheLugares.set(schoolId, { en: ahora, lugares });
        return lugares;
    } catch {
        return [];
    }
}

async function porLotes<T>(ids: string[], leer: (lote: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 200) out.push(...await leer(ids.slice(i, i + 200)));
    return out;
}

async function leerPersonas(tabla: string, ids: string[]): Promise<Map<string, { fecha: string | null; genero: string | null }>> {
    const filas = await porLotes(ids, async (lote) => {
        const { data } = await supabase.from(tabla).select('id, date_of_birth, gender').in('id', lote);
        return (data ?? []) as any[];
    });
    return new Map(filas.map((r) => [String(r.id), { fecha: r.date_of_birth ?? null, genero: r.gender ?? null }]));
}

/**
 * Rangos de todos los grupos de la escuela. Cacheado 1 h por escuela. Nunca
 * lanza: si algo falla devuelve [] (y quien llama sigue como antes).
 */
export async function rangosDeEscuela(schoolId: string, ahora: Date = new Date()): Promise<RangoGrupo[]> {
    const c = cache.get(schoolId);
    if (c && ahora.getTime() - c.en < TTL_CACHE_MS) return c.rangos;
    try {
        // `recibe_clase_prueba` llega con la migración M1: sin ella se lee lo
        // de siempre y todos los equipos cuentan como que la reciben.
        const COLUMNAS = 'id, name, age_min, age_max, schedule, admite_nuevos, active, status, category_id, branch_id, facility_id, coach_id';
        let r: any = await supabase.from('teams')
            .select(`${COLUMNAS}, recibe_clase_prueba`).eq('school_id', schoolId).limit(300);
        if (r?.error && faltaColumna(r.error, 'recibe_clase_prueba')) {
            r = await supabase.from('teams').select(COLUMNAS).eq('school_id', schoolId).limit(300);
        }
        const { data: equipos, error } = r ?? {};
        if (error || !Array.isArray(equipos)) return [];

        const catIds = [...new Set((equipos as any[]).map((t) => t.category_id).filter(Boolean))] as string[];
        const cats = catIds.length
            ? ((await supabase.from('school_categories')
                .select('id, age_min, age_max, birth_year_min, birth_year_max, rama, branch_id').in('id', catIds)).data ?? []) as any[]
            : [];
        const entrenadores = await entrenadoresDeEquipos(equipos as any[]);
        const catPorId = new Map(cats.map((x) => [String(x.id), x]));

        const { data: inscr } = await supabase.from('enrollments')
            .select('team_id, scheduling_team_id, child_id, user_id, unregistered_athlete_id')
            .eq('school_id', schoolId).eq('status', 'active').limit(5000);
        const ins = (inscr ?? []) as any[];
        const ids = (k: string) => [...new Set(ins.map((e) => e[k]).filter(Boolean))] as string[];
        const [ninos, sinCuenta, perfiles] = await Promise.all([
            leerPersonas('children', ids('child_id')),
            leerPersonas('unregistered_athletes', ids('unregistered_athlete_id')),
            leerPersonas('profiles', [...new Set(ins.filter((e) => !e.child_id && !e.unregistered_athlete_id)
                .map((e) => e.user_id).filter(Boolean))] as string[]),
        ]);
        const atletas: AtletaCrudo[] = ins.map((e) => {
            const p = e.child_id ? ninos.get(e.child_id)
                : e.unregistered_athlete_id ? sinCuenta.get(e.unregistered_athlete_id)
                : e.user_id ? perfiles.get(e.user_id) : undefined;
            return { teamId: e.team_id ?? e.scheduling_team_id ?? '', fechaNacimiento: p?.fecha ?? null, genero: p?.genero ?? null };
        });

        const rangos = construirRangos((equipos as any[]).map((t) => ({
            ...t, categoria: t.category_id ? catPorId.get(String(t.category_id)) ?? null : null,
            coachIds: entrenadores.get(String(t.id))?.ids, coachNombres: entrenadores.get(String(t.id))?.nombres,
        })), atletas, ahora);
        cache.set(schoolId, { en: ahora.getTime(), rangos });
        return rangos;
    } catch (e: any) {
        console.warn('[grupos-por-edad] no se pudieron leer los grupos', { schoolId, err: e?.message });
        return [];
    }
}
