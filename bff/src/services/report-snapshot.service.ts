/**
 * Arma el snapshot del Informe Mensual del Atleta.
 *
 * El snapshot es la ÚNICA fuente de la vista del padre, del correo y del PDF
 * (spec §8.4). Se congela al publicar: un informe que la familia ya leyó no
 * puede cambiar en silencio si mañana se corrige una medición.
 *
 * Vive en el BFF y no en SQL a propósito — decisión D-G de
 * `docs/plan-f1-informes-backend.md`: el cálculo de deltas, bandas y destacados
 * ya existe en el frontend, varias columnas que necesita no están versionadas, y
 * dos implementaciones del mismo ranking terminan divergiendo.
 *
 * ⚠️ GEMELO: el ranking de abajo es la contraparte de `pickHighlights` /
 * `pickToWorkOn` / `computeDelta` en `frontend/src/lib/school/performanceDisplay.ts`.
 * Son dos paquetes distintos, así que no se puede importar. Si se cambia el
 * criterio de uno hay que cambiar el otro, o el padre y el coach verán números
 * distintos del mismo mes. Los informes YA publicados no se ven afectados: leen
 * el snapshot congelado, no recalculan.
 */
import { supabase } from '../config/supabase';
import {
    getMetricCatalog,
    computeBand,
    type Band,
    type MetricDefinition,
} from './metric-catalog.service';

export type SubjectType = 'profile' | 'child' | 'unregistered';

export interface SnapshotMetric {
    metric_key: string;
    /** Rótulo de familia si existe; si no, el técnico. Resuelto acá, no en la UI. */
    label: string;
    hint: string | null;
    category: string | null;
    unit: string | null;
    higher_is_better: boolean;
    value: number;
    previous: number | null;
    delta: number | null;
    /** Δ relativo al rango de las bandas, o al valor previo. Ordena los destacados. */
    score: number | null;
    band: Band | null;
    measured_at: string;
}

/** Acumulados de fútbol DENTRO del periodo del informe -- derivados de
 *  match_lineup_players/football_match_events, no de performance_entries.
 *  null si el atleta no juega fútbol o no tuvo actividad este mes. */
export interface FootballSummary {
    matches_played: number;
    minutes_played: number;
    goals: number;
    own_goals: number;
    assists: number;
    yellow_cards: number;
    red_cards: number;
    /** Un partido por fecha, para el mapa de calor del mes. */
    match_days: { date: string; minutes_played: number }[];
}

/** Un día del periodo para el mapa de calor del informe: si hubo entreno,
 *  qué tan duro fue (promedio de `rpe_borg` ese día) y si fue día de
 *  partido. Complemento visual -- si las consultas fallan, el informe sale
 *  igual sin esta sección (mismo criterio que loadAttendance/loadFootballSummary). */
export interface CalendarDay {
    date: string;
    day: number;
    has_session: boolean;
    attended: boolean | null;
    /** Promedio de `rpe_borg` (0-10) registrado ese día; null si no se cargó. */
    effort: number | null;
    is_match: boolean;
    minutes_played: number | null;
}

/** Carga de entrenamiento del mes (PER-6 mitad B) -- sRPE de Foster, mismo
 *  cruce que `athlete_weekly_load` (D13) pero por mes calendario. null si
 *  el atleta no tuvo ninguna sesión con asistencia registrada ese mes. */
export interface TrainingLoadSummary {
    sessions_count: number;
    total_ua: number;
}

/** Una opción de una métrica de sesión con distribución (§3.4 del spec). */
export interface SessionMetricOption {
    value: number;
    label: string;
    n: number;
    pct: number;
}

/**
 * Agregado del periodo para una métrica de alta frecuencia (una medición por
 * sesión, ej. BORG, esfuerzo, comprensión — spec evaluacion-post-entrenamiento.md
 * §3.4). `metrics` (arriba) solo compara última-vs-anterior; esto promedia o
 * distribuye TODAS las mediciones del mes, que es lo que reproduce el PDF
 * original (fatiga en cubetas, % por respuesta, veces seleccionado).
 */
export interface SessionMetricSummary {
    metric_key: string;
    label: string;
    category: string | null;
    aggregation: 'avg' | 'distribution' | 'count';
    /** Sesiones respondidas en el periodo — SIEMPRE visible junto al dato (nunca se imputa lo que falta). */
    n: number;
    avg?: number;
    distribution?: SessionMetricOption[];
    /** Veces seleccionada (solo aggregation='count', ej. un ítem de "aspectos a mejorar"). */
    count?: number;
}

export interface ReportSnapshot {
    version: 1;
    generated_at: string;
    period: { year: number; month: number; label: string };
    athlete: { name: string; subject_type: SubjectType; subject_id: string };
    school: { id: string; name: string };
    teams: { id: string; name: string }[];
    governing_team: { id: string; name: string } | null;
    team_notes: { team_id: string; team_name: string; body: string }[];
    coach_note: string | null;
    attendance: { present: number; total: number; pct: number | null };
    highlights: SnapshotMetric[];
    to_work_on: SnapshotMetric[];
    metrics: SnapshotMetric[];
    /** Agregados de sesión del periodo (BORG, esfuerzo, comprensión, satisfacción, aspectos a mejorar). */
    metrics_session: SessionMetricSummary[];
    /** TODAS las métricas con medición hasta la fecha (no solo este mes) con
     *  su última banda -- el radar "panorama completo" que pidió Besser,
     *  misma idea que `PlayerCard.tsx`. `delta`/`previous`/`score` van null:
     *  acá no se compara con nada, es una foto del estado actual. */
    radar: SnapshotMetric[];
    /** Día a día del mes, para el mapa de calor (§ Besser 2026-11-03: "algo
     *  muy completo para los padres"). [] si no se pudo calcular. */
    calendar: CalendarDay[];
    football: FootballSummary | null;
    training_load: TrainingLoadSummary | null;
}

const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Columna de `enrollments` / `attendance_records` según el tipo de sujeto. */
function athleteColumn(t: SubjectType): 'user_id' | 'child_id' | 'unregistered_athlete_id' {
    return t === 'profile' ? 'user_id' : t === 'child' ? 'child_id' : 'unregistered_athlete_id';
}

/** Ancho de la banda verde→roja, para normalizar mejoras entre métricas. */
function metricRange(def: MetricDefinition): number | null {
    const values = def.thresholds
        .flatMap((t) => [t.min_value, t.max_value])
        .filter((v): v is number => typeof v === 'number');
    if (values.length < 2) return null;
    const span = Math.max(...values) - Math.min(...values);
    return span > 0 ? span : null;
}

/**
 * Cuánto mejoró, comparable entre métricas.
 *
 * Con bandas: Δ dividido por el ancho de la banda — «subió media banda».
 * Sin bandas: Δ relativo al valor previo. Los dos números no son estrictamente
 * comparables, y por eso las métricas en cm (sin bandas por edad todavía)
 * puntúan más bajo que las de 0-10. Se corrige solo cuando el coach cargue
 * normas por edad; no se compensa con un factor inventado.
 */
function improvementScore(def: MetricDefinition, current: number, previous: number | null): number | null {
    if (previous === null) return null;
    const raw = current - previous;
    const signed = def.higher_is_better ? raw : -raw;
    if (signed === 0) return 0;

    const range = metricRange(def);
    if (range) return signed / range;
    if (previous !== 0) return signed / Math.abs(previous);
    return null;
}

/**
 * Una medición por métrica: la última del periodo, más la anterior a ella (de
 * cualquier fecha) para poder calcular el delta. Sin la previa no hay «mejoró».
 *
 * También devuelve `allTime`: la última medición de CADA métrica hasta
 * `periodEnd`, sin exigir que caiga dentro del periodo -- es el insumo del
 * radar «panorama completo» (misma idea que `PlayerCard.tsx`, pero con lo que
 * ya se trajo acá: no agrega una consulta nueva).
 */
async function loadMetricSeries(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    periodEnd: Date,
    periodStart: Date,
) {
    const { data, error } = await supabase
        .from('performance_entries')
        .select('metric_key, value, recorded_at')
        .eq('school_id', schoolId)
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .lte('recorded_at', periodEnd.toISOString())
        .order('recorded_at', { ascending: true });

    if (error) throw error;

    const porMetrica = new Map<string, { value: number; recorded_at: string }[]>();
    for (const row of (data ?? []) as any[]) {
        const arr = porMetrica.get(row.metric_key) ?? [];
        arr.push({ value: Number(row.value), recorded_at: row.recorded_at });
        porMetrica.set(row.metric_key, arr);
    }

    // Solo entran las métricas medidas DENTRO del periodo: el informe de agosto
    // no habla de una métrica que solo se midió en junio.
    const periodFiltered = new Map<string, { current: { value: number; recorded_at: string }; previous: number | null }>();
    const allTime = new Map<string, { value: number; recorded_at: string }>();
    for (const [key, serie] of porMetrica) {
        const ultima = serie[serie.length - 1];
        allTime.set(key, ultima);
        if (new Date(ultima.recorded_at) < periodStart) continue;
        periodFiltered.set(key, {
            current: ultima,
            previous: serie.length >= 2 ? serie[serie.length - 2].value : null,
        });
    }
    return { periodFiltered, allTime };
}

/**
 * Día a día del periodo, para el mapa de calor del informe (pedido explícito
 * de Besser: "algo muy completo para los padres"). `rpe_borg` (cansancio
 * autopercibido, se carga después de cada entreno) da la intensidad; los
 * `matchDays` ya calculados por `loadFootballSummary` marcan los partidos.
 * Complemento visual -- si algo falla, el informe sale igual sin esta sección.
 */
async function loadCalendarDays(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    year: number,
    month: number,
    periodStart: Date,
    periodEnd: Date,
    matchDays: { date: string; minutes_played: number }[],
): Promise<CalendarDay[]> {
    try {
        const columna = athleteColumn(subjectType);
        const [{ data: attRows }, { data: rpeRows }] = await Promise.all([
            supabase.from('attendance_records').select('attendance_date, status')
                .eq('school_id', schoolId).eq(columna, subjectId)
                .gte('attendance_date', periodStart.toISOString().slice(0, 10))
                .lte('attendance_date', periodEnd.toISOString().slice(0, 10)),
            supabase.from('performance_entries').select('value, recorded_at')
                .eq('school_id', schoolId).eq('subject_type', subjectType).eq('subject_id', subjectId)
                .eq('metric_key', 'rpe_borg').eq('context_type', 'session')
                .gte('recorded_at', periodStart.toISOString()).lte('recorded_at', periodEnd.toISOString()),
        ]);

        const attByDate = new Map<string, string>();
        for (const r of (attRows ?? []) as any[]) attByDate.set(r.attendance_date, r.status);

        const rpeByDate = new Map<string, number[]>();
        for (const r of (rpeRows ?? []) as any[]) {
            const date = (r.recorded_at as string).slice(0, 10);
            const arr = rpeByDate.get(date) ?? [];
            arr.push(Number(r.value));
            rpeByDate.set(date, arr);
        }

        const matchByDate = new Map(matchDays.map((m) => [m.date, m.minutes_played]));

        const daysInMonth = periodEnd.getUTCDate();
        const days: CalendarDay[] = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const status = attByDate.get(date);
            const rpeValues = rpeByDate.get(date);
            const minutesPlayed = matchByDate.get(date) ?? null;
            days.push({
                date,
                day,
                has_session: status !== undefined || rpeValues !== undefined || minutesPlayed !== null,
                attended: status !== undefined ? (status === 'present' || status === 'late') : null,
                effort: rpeValues?.length ? Math.round((rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) * 10) / 10 : null,
                is_match: minutesPlayed !== null,
                minutes_played: minutesPlayed,
            });
        }
        return days;
    } catch {
        return [];
    }
}

/**
 * Asistencia del mes. `attendance_records` guarda una fila por atleta y día con
 * su estado; presente y tarde cuentan como asistencia.
 */
async function loadAttendance(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    periodStart: Date,
    periodEnd: Date,
) {
    const columna = athleteColumn(subjectType);
    const { data, error } = await supabase
        .from('attendance_records')
        .select('status')
        .eq('school_id', schoolId)
        .eq(columna, subjectId)
        .gte('attendance_date', periodStart.toISOString().slice(0, 10))
        .lte('attendance_date', periodEnd.toISOString().slice(0, 10));

    // La asistencia es un adorno del informe, no su razón de ser: si falla, el
    // informe igual sale. Sin esto un esquema distinto de attendance_records
    // tumbaría toda la publicación.
    if (error) return { present: 0, total: 0, pct: null };

    const filas = (data ?? []) as { status: string }[];
    const total = filas.length;
    const present = filas.filter((r) => r.status === 'present' || r.status === 'late').length;
    return { present, total, pct: total > 0 ? Math.round((present / total) * 100) : null };
}

/**
 * Acumulados de fútbol del periodo: alineaciones (minutos) + eventos (goles,
 * asistencias, tarjetas), acotados a partidos cuya fecha cae dentro del mes.
 * Igual que loadAttendance: es un complemento del informe, no su razón de
 * ser -- si algo falla, el informe sale igual sin la sección de fútbol.
 */
async function loadFootballSummary(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    periodStart: Date,
    periodEnd: Date,
): Promise<FootballSummary | null> {
    try {
        const { data: lineupRows, error: lineupErr } = await supabase
            .from('match_lineup_players')
            .select('minutes_played, match_lineups!inner(source_type, source_id)')
            .eq('school_id', schoolId)
            .eq('subject_type', subjectType)
            .eq('subject_id', subjectId);
        if (lineupErr) throw lineupErr;

        const rows = (lineupRows ?? []) as any[];
        if (rows.length === 0) return null;

        const teamMatchIds = rows
            .filter((r) => r.match_lineups.source_type === 'team_match')
            .map((r) => r.match_lineups.source_id);
        const tournamentMatchIds = rows
            .filter((r) => r.match_lineups.source_type === 'tournament_match')
            .map((r) => r.match_lineups.source_id);

        const periodStartDate = periodStart.toISOString().slice(0, 10);
        const periodEndDate = periodEnd.toISOString().slice(0, 10);

        const [teamMatchesInPeriod, tournamentMatchesInPeriod] = await Promise.all([
            teamMatchIds.length > 0
                ? supabase.from('match_results').select('id, match_date')
                    .in('id', teamMatchIds)
                    .gte('match_date', periodStartDate)
                    .lte('match_date', periodEndDate)
                : Promise.resolve({ data: [] as { id: string; match_date: string }[] }),
            tournamentMatchIds.length > 0
                ? supabase.from('tournament_matches').select('id, scheduled_at')
                    .in('id', tournamentMatchIds)
                    .gte('scheduled_at', periodStart.toISOString())
                    .lte('scheduled_at', periodEnd.toISOString())
                : Promise.resolve({ data: [] as { id: string; scheduled_at: string }[] }),
        ]);

        const teamDateById = new Map(
            ((teamMatchesInPeriod.data ?? []) as { id: string; match_date: string }[]).map((m) => [m.id, m.match_date]),
        );
        const tournamentDateById = new Map(
            ((tournamentMatchesInPeriod.data ?? []) as { id: string; scheduled_at: string }[])
                .map((m) => [m.id, m.scheduled_at.slice(0, 10)]),
        );
        const qualifyingIds = new Set([...teamDateById.keys(), ...tournamentDateById.keys()]);

        const rowsInPeriod = rows.filter((r) => qualifyingIds.has(r.match_lineups.source_id));
        if (rowsInPeriod.length === 0) return null;

        const matches_played = rowsInPeriod.filter((r) => r.minutes_played && r.minutes_played > 0).length;
        const minutes_played = rowsInPeriod.reduce((sum, r) => sum + (r.minutes_played ?? 0), 0);

        // Un partido por fecha (dos alineaciones el mismo día se suman) -- el
        // mapa de calor del informe marca el día, no el partido.
        const matchDaysMap = new Map<string, number>();
        for (const r of rowsInPeriod) {
            const sourceId = r.match_lineups.source_id;
            const date = r.match_lineups.source_type === 'team_match'
                ? teamDateById.get(sourceId)
                : tournamentDateById.get(sourceId);
            if (!date || !r.minutes_played) continue;
            matchDaysMap.set(date, (matchDaysMap.get(date) ?? 0) + r.minutes_played);
        }
        const match_days = [...matchDaysMap.entries()]
            .map(([date, minutesPlayed]) => ({ date, minutes_played: minutesPlayed }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const { data: eventRows, error: eventsErr } = await supabase
            .from('football_match_events')
            .select('type, source_id')
            .eq('school_id', schoolId)
            .eq('subject_type', subjectType)
            .eq('subject_id', subjectId);
        if (eventsErr) throw eventsErr;

        const eventsInPeriod = ((eventRows ?? []) as { type: string; source_id: string }[])
            .filter((e) => qualifyingIds.has(e.source_id));

        const counts = { goals: 0, own_goals: 0, assists: 0, yellow_cards: 0, red_cards: 0 };
        for (const e of eventsInPeriod) {
            if (e.type === 'goal') counts.goals++;
            else if (e.type === 'own_goal') counts.own_goals++;
            else if (e.type === 'assist') counts.assists++;
            else if (e.type === 'yellow') counts.yellow_cards++;
            else if (e.type === 'red') counts.red_cards++;
        }

        return { matches_played, minutes_played, ...counts, match_days };
    } catch {
        return null;
    }
}

/**
 * Carga de entrenamiento del mes (PER-6 mitad B, spec periodización §4 F6).
 * Mismo cruce que `athlete_weekly_load` (D13, sRPE de Foster × asistencia
 * real), pero por mes calendario vía la RPC de sistema
 * `athlete_monthly_load_system` -- este job corre con `service_role`, sin
 * `auth.uid()`, así que la RPC gateada por `user_staff_school_ids()` no
 * sirve acá (mismo motivo que las demás `_system`: `generate_report_drafts_system`).
 * Complemento del informe, no su razón de ser -- si falla o no hay datos,
 * el informe sale igual sin esta sección (mismo criterio que loadAttendance/loadFootballSummary).
 */
async function loadTrainingLoad(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    year: number,
    month: number,
): Promise<TrainingLoadSummary | null> {
    try {
        const { data, error } = await supabase
            .rpc('athlete_monthly_load_system', {
                p_school_id: schoolId,
                p_child_id: subjectType === 'child' ? subjectId : null,
                p_user_id: subjectType === 'profile' ? subjectId : null,
                p_unregistered_athlete_id: subjectType === 'unregistered' ? subjectId : null,
                p_year: year,
                p_month: month,
            })
            .single();
        if (error) throw error;
        const row = data as { sessions_count: number; total_ua: number } | null;
        if (!row || row.sessions_count === 0) return null;
        return { sessions_count: row.sessions_count, total_ua: Number(row.total_ua) };
    } catch {
        return null;
    }
}

/**
 * Agregados de sesión del periodo (§3.4 del spec) — promedio/distribución/conteo
 * de las métricas con context_type='session', a diferencia de `loadMetricSeries`
 * que solo compara última medición vs. anterior (correcto para una prueba física
 * mensual, no para algo que se registra 8-18 veces al mes).
 *
 * Denominador de las 'count' (aspectos a mejorar): sesiones donde SÍ hubo
 * autoevaluación ese periodo (proxy: cuántas veces se cargó rpe_borg, la única
 * pregunta obligatoria que ancla "respondió esta sesión").
 */
export async function loadSessionMetrics(
    schoolId: string,
    subjectType: SubjectType,
    subjectId: string,
    periodStart: Date,
    periodEnd: Date,
    catalogo: Map<string, MetricDefinition>,
): Promise<SessionMetricSummary[]> {
    const { data, error } = await supabase
        .from('performance_entries')
        .select('metric_key, value')
        .eq('school_id', schoolId)
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .eq('context_type', 'session')
        .gte('recorded_at', periodStart.toISOString())
        .lte('recorded_at', periodEnd.toISOString());

    if (error || !data) return [];

    const porMetrica = new Map<string, number[]>();
    for (const row of data as any[]) {
        const arr = porMetrica.get(row.metric_key) ?? [];
        arr.push(Number(row.value));
        porMetrica.set(row.metric_key, arr);
    }

    const sesionesRespondidas = porMetrica.get('rpe_borg')?.length ?? 0;
    const resultado: SessionMetricSummary[] = [];

    for (const [key, valores] of porMetrica) {
        const def = catalogo.get(key);
        if (!def || def.aggregation === 'latest') continue; // 'latest' ya lo cubre `metrics`
        const label = def.parent_label ?? def.display_name;

        if (def.aggregation === 'avg') {
            const avg = Math.round((valores.reduce((a, b) => a + b, 0) / valores.length) * 10) / 10;
            resultado.push({ metric_key: key, label, category: def.category, aggregation: 'avg', n: valores.length, avg });
        } else if (def.aggregation === 'distribution') {
            const total = valores.length;
            const counts = new Map<number, number>();
            for (const v of valores) counts.set(v, (counts.get(v) ?? 0) + 1);
            const distribution: SessionMetricOption[] = (def.options ?? []).map((o) => {
                const n = counts.get(o.value) ?? 0;
                return { value: o.value, label: o.label, n, pct: total > 0 ? Math.round((n / total) * 1000) / 10 : 0 };
            });
            resultado.push({ metric_key: key, label, category: def.category, aggregation: 'distribution', n: total, distribution });
        } else if (def.aggregation === 'count') {
            resultado.push({
                metric_key: key, label, category: def.category, aggregation: 'count',
                n: sesionesRespondidas, count: valores.length,
            });
        }
    }

    return resultado.sort((a, b) => a.metric_key.localeCompare(b.metric_key));
}

export interface BuildSnapshotInput {
    schoolId: string;
    subjectType: SubjectType;
    subjectId: string;
    year: number;
    month: number;
    /** Equipo que manda la fecha (D17). Puede ser null: atleta sin equipo (D-C). */
    governingTeamId: string | null;
    coachNote: string | null;
}

export async function buildReportSnapshot(input: BuildSnapshotInput): Promise<ReportSnapshot> {
    const { schoolId, subjectType, subjectId, year, month, governingTeamId, coachNote } = input;

    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    // ── Nombre del atleta y de la escuela ────────────────────────────────────
    const tablaSujeto = subjectType === 'profile' ? 'profiles'
        : subjectType === 'child' ? 'children'
        : 'unregistered_athletes';

    const [sujetoRes, escuelaRes] = await Promise.all([
        supabase.from(tablaSujeto).select('full_name').eq('id', subjectId).maybeSingle(),
        supabase.from('schools').select('id, name, category_id, sports_categories(name)').eq('id', schoolId).maybeSingle(),
    ]);

    const athleteName = (sujetoRes.data as any)?.full_name || 'El atleta';
    const schoolName = (escuelaRes.data as any)?.name || 'la escuela';
    const sportCategoryId = (escuelaRes.data as any)?.category_id as string | null;
    const sportCategoryName = ((escuelaRes.data as any)?.sports_categories?.name as string | undefined)?.toLowerCase();
    const esFutbol = (n?: string | null) => ['fútbol', 'futbol'].includes((n ?? '').trim().toLowerCase());

    // ── Equipos del atleta vigentes en el periodo ────────────────────────────
    const columna = athleteColumn(subjectType);
    const { data: inscripciones } = await supabase
        .from('enrollments')
        // FK explícita: enrollments tiene DOS llaves hacia teams (team_id y
        // scheduling_team_id). Sin el !, PostgREST responde PGRST201 y el
        // informe salía sin equipo, sin nota del equipo y sin nombre en el PDF.
        .select('team_id, teams!enrollments_team_id_fkey(id, name, sport)')
        .eq('school_id', schoolId)
        .eq(columna, subjectId)
        .not('team_id', 'is', null)
        .lte('start_date', periodEnd.toISOString().slice(0, 10));

    const equipos = ((inscripciones ?? []) as any[])
        .map((r) => r.teams)
        .filter((t): t is { id: string; name: string; sport: string | null } => !!t);
    const teams = equipos.map(({ id, name }) => ({ id, name }));

    const governingTeam = governingTeamId
        ? teams.find((t) => t.id === governingTeamId) ?? null
        : null;

    // Escuela multideporte: su category_id es UN deporte (el demo dice Golf), y
    // las métricas del atleta son las del deporte de SU equipo. Se suman al
    // catálogo los deportes de sus equipos; sin esto el informe salía sin
    // ninguna medición.
    const deportesEquipos = [...new Set(equipos.map((t) => t.sport).filter((x): x is string => !!x))];
    const { data: categoriasEquipos } = deportesEquipos.length
        ? await supabase.from('sports_categories').select('id, name').in('name', deportesEquipos)
        : { data: [] as any[] };
    const categoryIds = [sportCategoryId, ...((categoriasEquipos ?? []) as any[]).map((c) => c.id as string)];
    const deporteGobernante = equipos.find((t) => t.id === governingTeamId)?.sport ?? null;
    const isFootball = governingTeamId ? esFutbol(deporteGobernante) || (!deporteGobernante && esFutbol(sportCategoryName)) : esFutbol(sportCategoryName);

    // ── Notas de TODOS sus equipos del periodo (D17) ─────────────────────────
    // No solo la del gobernante: el snapshot promete «las notas de todos sus
    // equipos», y con el día más tardío gobernando ya vencieron todos los plazos.
    let teamNotes: ReportSnapshot['team_notes'] = [];
    if (teams.length > 0) {
        const { data: notas } = await supabase
            .from('team_report_notes')
            .select('team_id, body')
            .eq('school_id', schoolId)
            .eq('period_year', year)
            .eq('period_month', month)
            .in('team_id', teams.map((t) => t.id));

        teamNotes = ((notas ?? []) as any[]).map((n) => ({
            team_id: n.team_id,
            team_name: teams.find((t) => t.id === n.team_id)?.name ?? 'Equipo',
            body: n.body,
        }));
    }

    // ── Métricas ─────────────────────────────────────────────────────────────
    const [seriesResult, attendance, football, trainingLoad] = await Promise.all([
        loadMetricSeries(schoolId, subjectType, subjectId, periodEnd, periodStart),
        loadAttendance(schoolId, subjectType, subjectId, periodStart, periodEnd),
        isFootball ? loadFootballSummary(schoolId, subjectType, subjectId, periodStart, periodEnd) : Promise.resolve(null),
        loadTrainingLoad(schoolId, subjectType, subjectId, year, month),
    ]);
    const { periodFiltered: series, allTime } = seriesResult;
    // Depende de `football.match_days`, así que corre después del Promise.all.
    const calendar = await loadCalendarDays(
        schoolId, subjectType, subjectId, year, month, periodStart, periodEnd, football?.match_days ?? [],
    );

    // getMetricCatalog devuelve un array; se indexa por metric_key para no
    // recorrerlo una vez por medición.
    const definiciones = await getMetricCatalog(categoryIds, { includeInactive: true });
    const catalogo = new Map<string, MetricDefinition>(definiciones.map((d) => [d.metric_key, d]));

    const metricsSession = await loadSessionMetrics(schoolId, subjectType, subjectId, periodStart, periodEnd, catalogo);

    const metrics: SnapshotMetric[] = [];
    for (const [key, punto] of series) {
        const def = catalogo.get(key);
        if (!def) continue; // métrica sin catálogo: no hay forma de nombrarla al padre
        // Las de sesión (avg/distribution/count) ya se resumen en metrics_session
        // — mostrar además "última vs. anterior" de un valor que se registra 8-18
        // veces al mes es ruido, no información (spec §3.4).
        if (def.aggregation !== 'latest') continue;

        metrics.push({
            metric_key: key,
            // El rótulo de familia se resuelve ACÁ y queda congelado: si mañana
            // el coach lo cambia, el informe que el padre ya leyó no se altera.
            label: def.parent_label ?? def.display_name,
            hint: def.parent_hint,
            category: def.category,
            unit: def.unit,
            higher_is_better: def.higher_is_better,
            value: punto.current.value,
            previous: punto.previous,
            delta: punto.previous === null ? null : punto.current.value - punto.previous,
            score: improvementScore(def, punto.current.value, punto.previous),
            band: computeBand(punto.current.value, def.thresholds),
            measured_at: punto.current.recorded_at,
        });
    }

    // Panorama completo: última banda de CADA métrica con historia, sin
    // exigir que se haya tocado este mes -- es lo que ve PlayerCard.tsx desde
    // el roster, acá congelado para el informe del padre. A propósito INCLUYE
    // las de sesión (BORG, esfuerzo...): PlayerCard también las grafica con su
    // última lectura cruda, sin importar que en `metrics_session` arriba se
    // promedien distinto -- son dos lecturas legítimas del mismo dato.
    const radar: SnapshotMetric[] = [];
    for (const [key, punto] of allTime) {
        const def = catalogo.get(key);
        if (!def) continue;
        radar.push({
            metric_key: key,
            label: def.parent_label ?? def.display_name,
            hint: def.parent_hint,
            category: def.category,
            unit: def.unit,
            higher_is_better: def.higher_is_better,
            value: punto.value,
            previous: null,
            delta: null,
            score: null,
            band: computeBand(punto.value, def.thresholds),
            measured_at: punto.recorded_at,
        });
    }

    // Lo mejor de cada área, no el top-3 global: comparar entre categorías es lo
    // más débil (táctica y técnica son 0-6 y físico mezcla cm, reps y segundos),
    // y una familia entiende mejor un avance por área.
    const mejorPorCategoria = new Map<string, SnapshotMetric>();
    for (const m of metrics) {
        if (m.score === null || m.score <= 0) continue;
        const cat = m.category ?? 'other';
        const previo = mejorPorCategoria.get(cat);
        if (!previo || (m.score ?? 0) > (previo.score ?? 0)) mejorPorCategoria.set(cat, m);
    }
    const highlights = [...mejorPorCategoria.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Primero lo rojo, después lo amarillo; dentro de cada banda, lo peor arriba.
    const orden: Record<string, number> = { red: 0, yellow: 1 };
    const toWorkOn = metrics
        .filter((m) => m.band === 'red' || m.band === 'yellow')
        .sort((a, b) => (orden[a.band!] - orden[b.band!]) || ((a.score ?? 0) - (b.score ?? 0)))
        .slice(0, 3);

    return {
        version: 1,
        generated_at: new Date().toISOString(),
        period: { year, month, label: `${MESES[month - 1]} ${year}` },
        athlete: { name: athleteName, subject_type: subjectType, subject_id: subjectId },
        school: { id: schoolId, name: schoolName },
        teams,
        governing_team: governingTeam,
        team_notes: teamNotes,
        coach_note: coachNote,
        attendance,
        highlights,
        to_work_on: toWorkOn,
        metrics,
        metrics_session: metricsSession,
        radar,
        calendar,
        football,
        training_load: trainingLoad,
    };
}

// =============================================================================
// Informe DE EQUIPO (spec evaluacion-post-entrenamiento.md §3.5, F4 segunda
// mitad) — el PDF original de Besser es grupal, no por atleta. Reusa la misma
// agregación de `loadSessionMetrics` pero sobre TODAS las mediciones de sesión
// del equipo en el periodo, no de un solo sujeto.
// =============================================================================

export interface TeamReportSnapshot {
    version: 1;
    generated_at: string;
    period: { year: number; month: number; label: string };
    team: { id: string; name: string };
    school: { id: string; name: string };
    /** Deportistas distintos con al menos una autoevaluación en el periodo. */
    athlete_count: number;
    /** Sesiones del equipo en el periodo (hayan tenido respuestas o no). */
    sessions_count: number;
    metrics_session: SessionMetricSummary[];
}

async function loadTeamSessionMetrics(
    schoolId: string,
    teamId: string,
    periodStart: Date,
    periodEnd: Date,
    catalogo: Map<string, MetricDefinition>,
): Promise<{ metrics: SessionMetricSummary[]; sessionsCount: number; athleteCount: number }> {
    const { data: sesiones, error: sesionesErr } = await supabase
        .from('attendance_sessions')
        .select('id')
        .eq('team_id', teamId)
        .gte('session_date', periodStart.toISOString().slice(0, 10))
        .lte('session_date', periodEnd.toISOString().slice(0, 10));

    if (sesionesErr || !sesiones || sesiones.length === 0) {
        return { metrics: [], sessionsCount: 0, athleteCount: 0 };
    }

    const sessionIds = sesiones.map((s: any) => s.id);

    const { data, error } = await supabase
        .from('performance_entries')
        .select('metric_key, value, subject_type, subject_id')
        .eq('school_id', schoolId)
        .eq('context_type', 'session')
        .in('context_id', sessionIds);

    if (error || !data) return { metrics: [], sessionsCount: sessionIds.length, athleteCount: 0 };

    const porMetrica = new Map<string, number[]>();
    const atletas = new Set<string>();
    for (const row of data as any[]) {
        const arr = porMetrica.get(row.metric_key) ?? [];
        arr.push(Number(row.value));
        porMetrica.set(row.metric_key, arr);
        atletas.add(`${row.subject_type}:${row.subject_id}`);
    }

    // Denominador de las 'count': respuestas totales del equipo (suma de todas
    // las deportistas en todas las sesiones), no sesiones distintas — a nivel
    // de equipo "cuántas veces se respondió" es más útil que "cuántas sesiones".
    const totalRespuestas = porMetrica.get('rpe_borg')?.length ?? 0;
    const resultado: SessionMetricSummary[] = [];

    for (const [key, valores] of porMetrica) {
        const def = catalogo.get(key);
        if (!def || def.aggregation === 'latest') continue;
        const label = def.parent_label ?? def.display_name;

        if (def.aggregation === 'avg') {
            const avg = Math.round((valores.reduce((a, b) => a + b, 0) / valores.length) * 10) / 10;
            resultado.push({ metric_key: key, label, category: def.category, aggregation: 'avg', n: valores.length, avg });
        } else if (def.aggregation === 'distribution') {
            const total = valores.length;
            const counts = new Map<number, number>();
            for (const v of valores) counts.set(v, (counts.get(v) ?? 0) + 1);
            const distribution: SessionMetricOption[] = (def.options ?? []).map((o) => {
                const n = counts.get(o.value) ?? 0;
                return { value: o.value, label: o.label, n, pct: total > 0 ? Math.round((n / total) * 1000) / 10 : 0 };
            });
            resultado.push({ metric_key: key, label, category: def.category, aggregation: 'distribution', n: total, distribution });
        } else if (def.aggregation === 'count') {
            resultado.push({
                metric_key: key, label, category: def.category, aggregation: 'count',
                n: totalRespuestas, count: valores.length,
            });
        }
    }

    return {
        metrics: resultado.sort((a, b) => a.metric_key.localeCompare(b.metric_key)),
        sessionsCount: sessionIds.length,
        athleteCount: atletas.size,
    };
}

export interface BuildTeamSnapshotInput {
    schoolId: string;
    teamId: string;
    year: number;
    month: number;
}

export async function buildTeamReportSnapshot(input: BuildTeamSnapshotInput): Promise<TeamReportSnapshot> {
    const { schoolId, teamId, year, month } = input;
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    const [teamRes, escuelaRes] = await Promise.all([
        supabase.from('teams').select('id, name').eq('id', teamId).maybeSingle(),
        supabase.from('schools').select('id, name, category_id').eq('id', schoolId).maybeSingle(),
    ]);

    const teamName = (teamRes.data as any)?.name || 'Equipo';
    const schoolName = (escuelaRes.data as any)?.name || 'la escuela';
    const sportCategoryId = (escuelaRes.data as any)?.category_id as string | null;

    const definiciones = sportCategoryId
        ? await getMetricCatalog([sportCategoryId], { includeInactive: true })
        : [];
    const catalogo = new Map<string, MetricDefinition>(definiciones.map((d) => [d.metric_key, d]));

    const { metrics, sessionsCount, athleteCount } = await loadTeamSessionMetrics(
        schoolId, teamId, periodStart, periodEnd, catalogo,
    );

    return {
        version: 1,
        generated_at: new Date().toISOString(),
        period: { year, month, label: `${MESES[month - 1]} ${year}` },
        team: { id: teamId, name: teamName },
        school: { id: schoolId, name: schoolName },
        athlete_count: athleteCount,
        sessions_count: sessionsCount,
        metrics_session: metrics,
    };
}
