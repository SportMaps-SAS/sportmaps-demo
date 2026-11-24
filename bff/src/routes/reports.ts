import { Router, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { todayInZone, addDaysToDateString } from '../utils/businessDate';
import { armarInformeCartera, guardarAjusteInforme, informeACsv, leerAjusteInforme } from '../services/informe-cartera.service';
import { resolverAccesoEquipo } from '../services/team-access.service';

const router = Router();

/** Tamaño de página de PostgREST (`max-rows`). No se puede pedir más en una sola vuelta. */
const PG_PAGE = 1000;

/**
 * Trae TODAS las filas de una consulta, paginando con `.range()`.
 *
 * PostgREST corta en 1000 filas aunque no se pida `limit`, y lo hace en
 * silencio: un reporte de ingresos sobre una escuela con más de 1000 cobros
 * devolvía un total incompleto sin ninguna señal. Un reporte que miente por
 * debajo es peor que uno que falla.
 */
async function fetchAllRows<T>(build: () => any): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PG_PAGE) {
        const { data, error } = await build().range(from, from + PG_PAGE - 1);
        if (error) throw error;
        const page = (data || []) as T[];
        out.push(...page);
        if (page.length < PG_PAGE) return out;
    }
}

/**
 * Cuántos ids caben en un `.in()` sin reventar el límite de headers HTTP
 * (~16KB, undici/Node). Un uuid con comillas y coma pesa ~39 bytes; 30 ids
 * son ~1.2KB de query string — de sobra de margen aunque el resto de la URL
 * crezca (select largo, filtros, otro `.in()` en la misma query). No hace
 * falta ir al límite: una vuelta más de red no cuesta nada al lado de un 500.
 *
 * Medido en vivo: Dynasty (453 hijos activos) generaba una URL de 17.795
 * caracteres en `.in('id', athChildIds)` y el fetch moría con
 * HeadersOverflowError antes de llegar a PostgREST — un reporte que
 * funciona en escuelas chicas y se cae en las más grandes es peor que uno
 * que nunca funcionó.
 */
const IN_CHUNK = 30;

/**
 * Como `fetchAllRows`, pero además troceando una lista de ids que puede
 * superar IN_CHUNK. Los lotes van en PARALELO (`Promise.all`), no uno tras
 * otro — con IN_CHUNK=30 y una escuela de 453 hijos son ~16 lotes; en serie
 * eso es ~16 vueltas de red POR CADA .in() del endpoint (children, teams,
 * planes, asistencia, nameMap de pagos…), y sumado da los 10-20s medidos en
 * vivo. En paralelo, esas 16 vueltas cuestan lo mismo que 1.
 */
async function fetchRowsForIds<T>(ids: string[], build: (chunk: string[]) => any): Promise<T[]> {
    if (!ids.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));
    const pages = await Promise.all(chunks.map(chunk => fetchAllRows<T>(() => build(chunk))));
    return pages.flat();
}

/**
 * Suma de dinero realmente recibido. `paid` cuenta por el total del cobro y
 * `partial` solo por lo abonado — sumar `amount` de un abono infla el ingreso.
 */
const receivedAmount = (p: { status?: string | null; amount?: unknown; amount_paid?: unknown }): number =>
    Number(p.status === 'partial' ? (p.amount_paid ?? 0) : p.amount) || 0;

/**
 * Días entre dos 'YYYY-MM-DD', positivo si `b` es posterior a `a`. Misma
 * aritmética UTC pura de `addDaysToDateString` — nada de `Date` construido
 * desde string, que es de donde salen los corrimientos de un día.
 */
const daysBetween = (a: string, b: string): number => {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
};

// Middleware helper to determine which branch_id to filter by.
const getBranchFilter = (req: AuthenticatedRequest): string | null => {
    if (req.role === 'school_admin') return req.branchId;
    const queryBranchId = req.query.branch_id as string;
    if (queryBranchId && queryBranchId !== 'undefined' && queryBranchId !== 'null') {
        return queryBranchId;
    }
    return null;
};

/**
 * Filtro de sede sobre `payments` (multisede, docs/specs/multisede-selector-y-sede-del-atleta.md).
 * Escuela con VARIAS sedes: con una sede elegida solo entran los cobros de esa
 * sede; un cobro sin sede no se reparte en todas (se contaría dos veces al
 * sumar sedes) y solo aparece sin filtro, como «Sin sede». Escuela de UNA sede:
 * NULL es esa sede (como get_single_branch_id en la vista school_athletes), así
 * que se sigue incluyendo — con `.eq()` se caían 44 de 89 pagos de Dynasty.
 */
const applyPaymentBranchFilter = <Q extends { eq: any; or: any }>(q: Q, branchFilterId: string | null, multiBranch: boolean): Q => {
    if (!branchFilterId) return q;
    return multiBranch
        ? q.eq('branch_id', branchFilterId)
        : q.or(`branch_id.is.null,branch_id.eq.${branchFilterId}`);
};

/** ¿La escuela tiene más de una sede? (una consulta `head`, sin filas). */
const schoolHasManyBranches = async (schoolId: string | undefined | null): Promise<boolean> => {
    if (!schoolId) return false;
    const { count } = await supabase
        .from('school_branches')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', schoolId);
    return (count || 0) > 1;
};

/**
 * Ocupación por equipo y crecimiento de los últimos 6 meses (nuevos y retiros
 * por mes de creación de la inscripción): la parte de inscripciones de
 * GET /school/summary, sin Express. La usan esa ruta y el reporte
 * «inscripciones» de Mapi (services/mapi-agente/herramientas/informes.ts).
 * `meses` trae el AAAA-MM de cada punto de `growthDataList`; la ruta no lo devuelve.
 */
export async function ocupacionYCrecimiento(schoolId: string, branchFilterId: string | null) {
    // 1. Obtener equipos (Teams) para capacidad total y lista de IDs
    let teamsQuery = supabase
        .from('teams')
        .select('id, name, max_students')
        .eq('school_id', schoolId)
        .eq('status', 'active');

    if (branchFilterId) teamsQuery = teamsQuery.eq('branch_id', branchFilterId);

    const { data: allTeams, error: teamsError } = await teamsQuery;
    if (teamsError) throw teamsError;

    const teams = allTeams || [];
    let realTotalCapacity = 0;
    const teamCapacityMap = new Map<string, number>();
    const teamIdToName = new Map<string, string>();

    allTeams?.forEach(t => {
        const cap = t.max_students || 0; // Changed from max_capacity to max_students to match select
        if (cap > 0) {
            // Agrupar por nombre (ej. "Pre-infantil") ignorando la sede
            teamCapacityMap.set(t.name, (teamCapacityMap.get(t.name) || 0) + cap);
            realTotalCapacity += cap; // Added this line to correctly calculate total capacity
        }
        teamIdToName.set(t.id, t.name);
    });

    // 2. Obtener inscripciones (Enrollments) — SIN join a teams para evitar PGRST201.
    //    La relación ambigua ocurre porque enrollments tiene múltiples FK a teams.
    //    Solución: filtrar por los team_ids ya obtenidos en el paso anterior.
    const teamIds = teams.map((t: any) => t.id);

    const allEnrollmentsSet = new Set<string>(); // para deportistas únicos 

    const teamOccupiedMap = new Map<string, number>();
    let totalStudents = 0;
    const growthMap = new Map<string, { nuevos: number; retiros: number; sortKey: number }>();
    const mesDeClave = new Map<string, string>();
    const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const now = new Date();
    const currentMonthIndex = now.getMonth();
    const currentYear = now.getFullYear();
    let netGrowthThisMonth = 0;

    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const mKey = MONTHS[d.getMonth()];
        growthMap.set(mKey, { nuevos: 0, retiros: 0, sortKey: d.getTime() });
        mesDeClave.set(mKey, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    if (teamIds.length > 0) {
        // Usamos `team_id` directamente — columna plana, sin join, sin ambigüedad
        const { data: enrollmentsData, error: enrollError } = await supabase
            .from('enrollments')
            .select('status, created_at, team_id')
            .in('team_id', teamIds);

        if (enrollError) throw enrollError;

        (enrollmentsData || []).forEach((e: any) => {
            const teamName = teamIdToName.get(e.team_id) || 'Varios';
            const d = new Date(e.created_at);
            const mKey = MONTHS[d.getMonth()];

            if (e.status === 'active') {
                if (teamName) {
                    teamOccupiedMap.set(teamName, (teamOccupiedMap.get(teamName) || 0) + 1);
                }
                totalStudents++;
                if (d.getMonth() === currentMonthIndex && d.getFullYear() === currentYear) {
                    netGrowthThisMonth++;
                }
                if (growthMap.has(mKey)) growthMap.get(mKey)!.nuevos++;
            } else if (e.status === 'inactive' || e.status === 'dropped') {
                if (growthMap.has(mKey)) growthMap.get(mKey)!.retiros++;
            }
        });
    }

    // 4) Combinar Mapas: Capacidad vs Ocupación
    const occupancyData = Array.from(teamCapacityMap.entries()).map(([name, capacity]) => ({
        name,
        occupied: teamOccupiedMap.get(name) || 0,
        vacant: Math.max(0, capacity - (teamOccupiedMap.get(name) || 0)),
        total_capacity: capacity
    })).slice(0, 10);

    const growthDataList = Array.from(growthMap.entries())
        .sort((a, b) => a[1].sortKey - b[1].sortKey)
        .map(([month, data]) => ({ month, nuevos: data.nuevos, retiros: data.retiros }));

    const meses = growthDataList.map((g) => mesDeClave.get(g.month) ?? null);
    return { realTotalCapacity, totalStudents, netGrowthThisMonth, occupancyData, growthDataList, meses };
}

// ── GET /api/v1/reports/school/summary ───────────────────────────────────────
router.get(
    '/school/summary',
    requireAuth,
    requireRole('owner', 'super_admin', 'admin', 'auditor', 'reporter', 'school_admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const { schoolId } = req;
            const branchFilterId = getBranchFilter(req);

            const { realTotalCapacity, totalStudents, netGrowthThisMonth, occupancyData, growthDataList } =
                await ocupacionYCrecimiento(schoolId, branchFilterId);

            // 3. Obtener Pagos confirmados (histórico completo, paginado)
            //    `partial` entra por lo abonado: un abono también es plata que entró.
            //    Si esta consulta falla, el endpoint falla: devolver el reporte con
            //    `totalRevenue: 0` se lee como "no hubo ingresos". El frontend ya
            //    tiene su propio fallback contra Supabase para este caso.
            const multiBranch = branchFilterId ? await schoolHasManyBranches(schoolId) : false;
            const payments: any[] = await fetchAllRows<any>(() => {
                let q = supabase
                    .from('payments')
                    .select('amount, amount_paid, status, concept')
                    .eq('school_id', schoolId)
                    .in('status', ['paid', 'partial'])
                    // `id` fija el orden: sin él, dos páginas del mismo `.range()`
                    // pueden repetir o saltarse filas.
                    .order('id', { ascending: true });
                // Un cobro con `branch_id` NULL es un cobro SIN sede asignada, no uno
                // de otra sede. Ver applyPaymentBranchFilter.
                return applyPaymentBranchFilter(q, branchFilterId, multiBranch);
            });

            let revenueSum = 0;
            const revenueByConcept = new Map<string, number>();

            (payments || []).forEach((p: any) => {
                const amt = receivedAmount(p);
                revenueSum += amt;
                const conceptShort = p.concept?.split('-')[0]?.trim() || 'General';
                revenueByConcept.set(conceptShort, (revenueByConcept.get(conceptShort) || 0) + amt);
            });

            const revenueData = Array.from(revenueByConcept.entries())
                .map(([name, value]) => ({ name, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 5);

            return res.json({
                summary: {
                    occupancyRate: realTotalCapacity > 0
                        ? ((totalStudents / realTotalCapacity) * 100).toFixed(1)
                        : '0',
                    totalStudents,
                    totalCapacity: realTotalCapacity,
                    totalRevenue: revenueSum,
                    netGrowth: netGrowthThisMonth,
                },
                charts: { occupancyData, growthData: growthDataList, revenueData },
            });

        } catch (err: any) {
            req.log?.error({ err: err.message || err }, 'Error en reporte general de escuela');
            return res.status(500).json({ error: 'Error interno obteniendo reportes.' });
        }
    }
);

// ── GET /api/v1/reports/reporter/dashboard ────────────────────────────────────
router.get(
    '/reporter/dashboard',
    requireAuth,
    requireRole('owner', 'super_admin', 'admin', 'auditor', 'reporter', 'school_admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const { schoolId } = req;
            const branchFilterId = getBranchFilter(req);
            const days = parseInt(req.query.days as string) || 30;
            const teamFilterId = (req.query.team_id as string) || undefined;
            const planFilterId = (req.query.offering_plan_id as string) || undefined;

            // Ventana en hora Colombia. `toISOString()` sobre el reloj de Render
            // (UTC) corría el inicio de la ventana un día después de las 7 p.m.
            const today = todayInZone();
            const since = addDaysToDateString(today, -days);

            // ── 1. Deportistas y su cuota ────────────────────────────────────────
            // El KPI "Ingreso Potencial Mes" se arma sumando la cuota de esta lista, así
            // que la cuota TIENE que resolverse por la misma cadena que genera los
            // cobros. Antes salía de `children.monthly_fee || teams.price_monthly`, que
            // se salta los DOS primeros eslabones de esa cadena. Medido el 2026-08-06:
            // el KPI mostraba $10.390.000 contra $66.250.000 reales — 435 atletas y una
            // brecha de $55.860.000, o sea el 16% de lo que debía mostrar.
            //
            // Cadena canónica, la de open_month (mig 20260803114540):
            //   COALESCE(NULLIF(e.monthly_fee,0), NULLIF(op.price,0),
            //            NULLIF(t.price_monthly,0), NULLIF(c.monthly_fee,0), 0)
            //
            // El NULLIF no es decorativo: un 0 no es un precio, es un "sin definir" que
            // cae al siguiente eslabón. Por eso acá se busca el primer valor DISTINTO DE
            // CERO y no el primero no nulo.
            //
            // Y el eje pasa a ser la INSCRIPCIÓN ACTIVA, no `children`: los atletas
            // adultos (`user_id`) y los no registrados (`unregistered_athlete_id`)
            // también pagan, y para este KPI sencillamente no existían.
            const { data: enrollmentsRaw, error: enrollmentsErr } = await supabase
                .from('enrollments')
                .select('id, child_id, user_id, unregistered_athlete_id, team_id, offering_plan_id, monthly_fee, created_at')
                .eq('school_id', schoolId)
                .eq('status', 'active');
            if (enrollmentsErr) throw enrollmentsErr;

            // Un atleta puede tener varias inscripciones activas, pero open_month le
            // genera UN solo cobro, eligiendo con este desempate: el plan gobierna,
            // luego el equipo, y a igualdad la más antigua (la que carga el historial).
            // Se replica igual, o el potencial contaría dos veces a la misma persona.
            const enrollmentRank = (e: any): [number, number, string] => [
                e.offering_plan_id ? 0 : 1,
                e.team_id ? 0 : 1,
                String(e.created_at ?? ''),
            ];
            const enrollmentByAthlete = new Map<string, any>();
            for (const e of (enrollmentsRaw || [])) {
                const athleteId = e.child_id || e.user_id || e.unregistered_athlete_id;
                if (!athleteId) continue;
                const prev = enrollmentByAthlete.get(athleteId);
                if (!prev) { enrollmentByAthlete.set(athleteId, e); continue; }
                const [ap, at, ac] = enrollmentRank(e);
                const [bp, bt, bc] = enrollmentRank(prev);
                if (ap < bp || (ap === bp && (at < bt || (at === bt && ac < bc)))) {
                    enrollmentByAthlete.set(athleteId, e);
                }
            }
            const chosenEnrollments = [...enrollmentByAthlete.values()];

            const uniqIds = (xs: any[]): string[] => [...new Set(xs.filter(Boolean))] as string[];
            const athChildIds = uniqIds(chosenEnrollments.map((e: any) => e.child_id));
            const athUserIds  = uniqIds(chosenEnrollments.map((e: any) => e.user_id));
            const athUaIds    = uniqIds(chosenEnrollments.map((e: any) => e.unregistered_athlete_id));
            const athTeamIds  = uniqIds(chosenEnrollments.map((e: any) => e.team_id));
            const athPlanIds  = uniqIds(chosenEnrollments.map((e: any) => e.offering_plan_id));

            const [childRows, athProfileRows, uaRows, teamRows, planRows] = await Promise.all([
                fetchRowsForIds<any>(athChildIds, chunk => supabase.from('children').select('id, full_name, branch_id, monthly_fee, created_at').in('id', chunk)),
                fetchRowsForIds<any>(athUserIds, chunk => supabase.from('profiles').select('id, full_name').in('id', chunk)),
                fetchRowsForIds<any>(athUaIds, chunk => supabase.from('unregistered_athletes').select('id, full_name, branch_id, created_at').in('id', chunk)),
                // La cuota del equipo es `price_monthly`; `monthly_fee` NO existe en
                // teams (sí en children/enrollments) y pedirla hacía fallar el select
                // completo → 500 en todo el dashboard.
                fetchRowsForIds<any>(athTeamIds, chunk => supabase.from('teams').select('id, name, price_monthly, branch_id').in('id', chunk)),
                fetchRowsForIds<any>(athPlanIds, chunk => supabase.from('offering_plans').select('id, name, price, max_sessions').in('id', chunk)),
            ]);

            const childMap       = new Map(childRows.map((c: any) => [c.id, c]));
            const athProfileMap  = new Map(athProfileRows.map((p: any) => [p.id, p]));
            const uaMap          = new Map(uaRows.map((u: any) => [u.id, u]));
            const teamMap        = new Map(teamRows.map((t: any) => [t.id, t]));
            const planMap        = new Map(planRows.map((p: any) => [p.id, p]));

            const teamNameMap = new Map<string, string>();
            teamRows.forEach((t: any) => teamNameMap.set(t.id, t.name));

            // Sedes de la escuela (todas, sin el filtro: hace falta saber si es
            // multisede para decidir qué hacer con lo que no tiene sede).
            const { data: schoolBranchRows, error: schoolBranchErr } = await supabase
                .from('school_branches')
                .select('id, name')
                .eq('school_id', schoolId)
                .order('name', { ascending: true });
            if (schoolBranchErr) throw schoolBranchErr;
            const schoolBranches = (schoolBranchRows || []) as { id: string; name: string }[];
            const branchNameMap = new Map<string, string>(schoolBranches.map(b => [b.id, b.name]));
            const multiBranch = schoolBranches.length > 1;
            // Escuela de una sola sede: lo que no tiene sede ES esa sede (misma regla
            // que get_single_branch_id en la vista school_athletes).
            const singleBranchId = schoolBranches.length === 1 ? schoolBranches[0].id : null;
            const SIN_SEDE = 'Sin sede';
            const sedeName = (branchId: string | null | undefined): string =>
                (branchId && branchNameMap.get(branchId)) || SIN_SEDE;

            // La sede sale de `COALESCE(children.branch_id, teams.branch_id)`, igual que
            // en open_month; el adulto (`user_id`) toma la del equipo, y la ficha sin
            // cuenta la del equipo o, sin equipo con sede, la de la ficha. Lo que queda
            // sin sede en una escuela multisede se reporta como «Sin sede» (antes
            // «Principal», que hacía creer que estaba en la sede principal).
            const branchOf = (e: any): string | null =>
                (childMap.get(e.child_id) as any)?.branch_id
                || (teamMap.get(e.team_id) as any)?.branch_id
                || (uaMap.get(e.unregistered_athlete_id) as any)?.branch_id
                || singleBranchId;

            // Primer valor distinto de cero: el equivalente en JS del NULLIF(x, 0) de la
            // cadena canónica. `Number(null)` es 0 y `Number(undefined)` es NaN, así que
            // el saneo tiene que ser explícito.
            const firstNonZero = (...vals: any[]): number => {
                for (const v of vals) {
                    const n = Number(v);
                    if (Number.isFinite(n) && n !== 0) return n;
                }
                return 0;
            };

            // Asistencia real marcada por el entrenador, acotada a la MISMA ventana
            // que los pagos (`since` → hoy) — igual que un plan de "4 clases al mes"
            // se mide por mes, no por la vida entera de la inscripción. Sin esto, un
            // atleta con un año de historial mostraba 40+ asistencias contra un cupo
            // mensual de 4, un "40/4" que no dice nada.
            // `attendance_records` solo tiene `child_id` (ver mig 20260217000001):
            // adultos y no-registrados quedan sin fila acá → `null` (no aplica), no 0.
            const attendanceByChild = new Map<string, number>();
            if (athChildIds.length > 0) {
                const attendanceRows = await fetchRowsForIds<any>(athChildIds, chunk => supabase
                    .from('attendance_records')
                    .select('child_id, status')
                    .in('child_id', chunk)
                    .gte('attendance_date', since)
                    .order('id', { ascending: true }));
                attendanceRows.forEach((r: any) => {
                    if (r.status !== 'present' && r.status !== 'late') return;
                    attendanceByChild.set(r.child_id, (attendanceByChild.get(r.child_id) || 0) + 1);
                });
            }

            const athleteRows = chosenEnrollments.map((e: any) => {
                const child = childMap.get(e.child_id) as any;
                const team  = teamMap.get(e.team_id) as any;
                const plan  = planMap.get(e.offering_plan_id) as any;
                const branchId = branchOf(e);
                return {
                    id: e.child_id || e.user_id || e.unregistered_athlete_id,
                    full_name: child?.full_name
                        || (athProfileMap.get(e.user_id) as any)?.full_name
                        || (uaMap.get(e.unregistered_athlete_id) as any)?.full_name
                        || 'Sin nombre',
                    team: teamNameMap.get(e.team_id) || '—',
                    plan: plan?.name || '—',
                    // Asistidas (en la ventana) contra el CUPO DEL PLAN, no contra el
                    // total de asistencia marcada — "3/4" = 3 de las 4 clases que el
                    // plan incluye, no "3 de 3 veces que se pasó lista".
                    sessions_attended: e.child_id ? (attendanceByChild.get(e.child_id) || 0) : null,
                    sessions_total: plan?.max_sessions ?? null,
                    sede: sedeName(branchId),
                    status: 'active',
                    fee: firstNonZero(e.monthly_fee, plan?.price, team?.price_monthly, child?.monthly_fee),
                    joined: child?.created_at || (uaMap.get(e.unregistered_athlete_id) as any)?.created_at || e.created_at,
                    branchId,
                    teamId: e.team_id || null,
                    planId: e.offering_plan_id || null,
                };
            });

            const athletesInScope = athleteRows.filter(r =>
                (!branchFilterId || r.branchId === branchFilterId)
                && (!teamFilterId || r.teamId === teamFilterId)
                && (!planFilterId || r.planId === planFilterId)
            );

            // El potencial se calcula sobre TODOS los atletas del alcance y viaja aparte.
            // La lista va capada a 500 filas, y cuando el front sumaba la lista el KPI
            // quedaba corto en silencio para cualquier escuela con más de 500 atletas.
            const revenuePotential = athletesInScope.reduce((sum, r) => sum + r.fee, 0);

            const students = athletesInScope
                .slice()
                .sort((a, b) => String(b.joined ?? '').localeCompare(String(a.joined ?? '')))
                .slice(0, 500)
                .map(({ branchId, teamId, planId, ...rest }) => rest);

            // 2. Payments
            // `payments` no tiene `payment_month` ni `student_id`: el periodo vive
            // en period_year/period_month y el sujeto del cobro es child_id (menor),
            // user_id/parent_id (adulto) o unregistered_athlete_id. Pedir las
            // columnas viejas hacía fallar el select y devolvía 500 en todo el
            // dashboard del auditor.
            let paymentsQuery = supabase
                .from('payments')
                .select('id, amount, amount_paid, status, concept, due_date, payment_date, period_year, period_month, created_at, child_id, user_id, parent_id, unregistered_athlete_id, branch_id')
                .eq('school_id', schoolId)
                // `cancelled`/`failed` no son un cobro vigente en ningún sentido — ni
                // recaudado, ni por cobrar, ni vencido — pero SÍ entraban al listado y
                // al total de filas, así que el conteo del reporte ("Mostrando 30 de
                // 696") no cerraba con la suma de los 3 KPIs (paid+pending+overdue).
                // Medido en Dynasty: 219 de 696 pagos del período eran `cancelled`.
                .not('status', 'in', '(cancelled,failed)')
                // La ventana mira las DOS fechas. Con solo `created_at` se caía del
                // reporte un pago cobrado dentro del período cuyo cobro se había
                // emitido antes — que es el caso normal de una mensualidad (48 de
                // los 89 pagos de agosto de Dynasty).
                .or(`created_at.gte.${since},payment_date.gte.${since}`)
                .order('created_at', { ascending: false })
                .limit(PG_PAGE);

            // branch_id NULL = sin sede asignada, no "de otra sede". Ver
            // applyPaymentBranchFilter.
            paymentsQuery = applyPaymentBranchFilter(paymentsQuery, branchFilterId, multiBranch);

            const { data: paymentsRaw, error: paymentsErr } = await paymentsQuery;
            if (paymentsErr) throw paymentsErr;

            // Equipo/plan del cobro salen de la MISMA inscripción elegida arriba para
            // el atleta — no hay FK directa cobro→equipo. Un cobro cuyo atleta ya no
            // tiene inscripción activa (se dio de baja) no matchea ningún equipo/plan
            // y solo se ve si no hay filtro puesto.
            const paymentAthleteId = (p: any) => p.child_id || p.unregistered_athlete_id || p.user_id || p.parent_id;
            const paymentsInScope = (teamFilterId || planFilterId)
                ? (paymentsRaw || []).filter((p: any) => {
                    const enr = enrollmentByAthlete.get(paymentAthleteId(p));
                    if (!enr) return false;
                    if (teamFilterId && enr.team_id !== teamFilterId) return false;
                    if (planFilterId && enr.offering_plan_id !== planFilterId) return false;
                    return true;
                })
                : (paymentsRaw || []);

            // Nombre del deportista según las TRES identidades posibles del cobro.
            const nameMap = new Map<string, string>();
            const collect = async (table: string, ids: string[]) => {
                const rows = await fetchRowsForIds<any>(ids, chunk => supabase.from(table).select('id, full_name').in('id', chunk));
                rows.forEach((r: any) => nameMap.set(r.id, r.full_name));
            };
            const uniq = (key: string) =>
                [...new Set(paymentsInScope.map((p: any) => p[key]).filter(Boolean))] as string[];
            await Promise.all([
                collect('children', uniq('child_id')),
                collect('unregistered_athletes', uniq('unregistered_athlete_id')),
                collect('profiles', [...new Set([...uniq('user_id'), ...uniq('parent_id')])]),
            ]);

            const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
            const periodo = (p: any) => {
                if (p.period_year && p.period_month) return `${MESES[p.period_month - 1]} ${p.period_year}`;
                const ref = p.due_date || p.created_at;
                if (!ref) return '—';
                const d = new Date(ref);
                return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
            };

            const payments = paymentsInScope.map((p: any) => {
                const enr = enrollmentByAthlete.get(paymentAthleteId(p));
                const plan = enr?.offering_plan_id ? planMap.get(enr.offering_plan_id) as any : null;
                return {
                    id: p.id,
                    student: nameMap.get(p.child_id)
                        || nameMap.get(p.unregistered_athlete_id)
                        || nameMap.get(p.user_id)
                        || nameMap.get(p.parent_id)
                        || 'Desconocido',
                    amount: Number(p.amount) || 0,
                    // Solo tiene sentido para `partial`: cuánto de ese cobro ya entró.
                    amount_paid: p.status === 'partial' ? (Number(p.amount_paid) || 0) : null,
                    status: p.status || 'pending',
                    month: periodo(p),
                    // `team` es el EQUIPO real de la inscripción, no el concepto del
                    // cobro — antes se mostraba `p.concept` bajo la etiqueta "Equipo",
                    // lo que rompía cualquier filtro/agrupación real por equipo.
                    team: (enr?.team_id && teamNameMap.get(enr.team_id)) || '—',
                    plan: plan?.name || '—',
                    concept: p.concept || '—',
                    due_date: p.due_date || null,
                    payment_date: p.payment_date || null,
                    // + = vencido hace N días, − = faltan N días para vencer, null = sin fecha.
                    // Para `paid` esto NO significa que siga vencido — ya se cobró; el
                    // frontend decide qué mostrar según el status, no solo este número.
                    days: p.due_date ? daysBetween(p.due_date, today) : null,
                };
            });

            // 3. Coaches — sin join ambiguo
            let coachesQuery = supabase
                .from('school_members')
                .select('id, role, profile_id, branch_id')
                .eq('school_id', schoolId)
                .in('role', ['coach', 'staff']);

            if (branchFilterId) coachesQuery = coachesQuery.eq('branch_id', branchFilterId);

            const { data: coachesRaw, error: coachesErr } = await coachesQuery;
            if (coachesErr) throw coachesErr;

            const coachProfileIds = (coachesRaw || []).map((c: any) => c.profile_id).filter(Boolean);
            const profileMap = new Map<string, { full_name: string; email: string }>();
            if (coachProfileIds.length > 0) {
                const { data: profiles } = await supabase
                    .from('profiles')
                    .select('id, full_name, email')
                    .in('id', coachProfileIds);
                (profiles || []).forEach((p: any) => profileMap.set(p.id, { full_name: p.full_name, email: p.email }));
            }

            const coaches = (coachesRaw || []).map((m: any) => ({
                id: m.id,
                name: profileMap.get(m.profile_id)?.full_name || 'Sin nombre',
                email: profileMap.get(m.profile_id)?.email || '—',
                team: '—',
                sede: sedeName(m.branch_id || singleBranchId),
                students: 0,
            }));

            // 4. Sedes — desglose por sede SIN N+1: cuatro lecturas para toda la
            // escuela (niños y fichas sin inscripción, staff, cobros) y se agrupa en
            // memoria. Antes eran 3 consultas POR sede y los alumnos salían solo de
            // `children.branch_id`: en Monster (todo fichas) cada sede daba ≈0.
            //
            // Alumnos = personas distintas: los de inscripción activa (niño, adulto
            // o ficha, con su sede por `branchOf`) + los niños y fichas ACTIVOS sin
            // inscripción activa, con la sede de su registro.
            const [loneChildren, loneUas, staffRows, paidRows] = await Promise.all([
                fetchAllRows<any>(() => supabase
                    .from('children')
                    .select('id, branch_id')
                    .eq('school_id', schoolId)
                    .eq('is_active', true)
                    .order('id', { ascending: true })),
                fetchAllRows<any>(() => supabase
                    .from('unregistered_athletes')
                    .select('id, branch_id')
                    .eq('school_id', schoolId)
                    .eq('is_active', true)
                    .order('id', { ascending: true })),
                fetchAllRows<any>(() => supabase
                    .from('school_members')
                    .select('id, branch_id')
                    .eq('school_id', schoolId)
                    .in('role', ['coach', 'staff'])
                    .order('id', { ascending: true })),
                fetchAllRows<any>(() => supabase
                    .from('payments')
                    .select('id, amount, amount_paid, status, branch_id')
                    .eq('school_id', schoolId)
                    .in('status', ['paid', 'partial'])
                    .order('id', { ascending: true })),
            ]);

            const NO_BRANCH = '__sin_sede__';
            const keyOf = (branchId: string | null | undefined) => branchId || singleBranchId || NO_BRANCH;
            const tally = new Map<string, { students: number; coaches: number; income: number }>();
            const bucket = (k: string) => {
                let b = tally.get(k);
                if (!b) { b = { students: 0, coaches: 0, income: 0 }; tally.set(k, b); }
                return b;
            };
            const counted = new Set<string>();
            athleteRows.forEach(r => {
                if (!r.id || counted.has(r.id)) return;
                counted.add(r.id);
                bucket(keyOf(r.branchId)).students++;
            });
            [...loneChildren, ...loneUas].forEach((a: any) => {
                if (counted.has(a.id)) return;
                counted.add(a.id);
                bucket(keyOf(a.branch_id)).students++;
            });
            staffRows.forEach((m: any) => { bucket(keyOf(m.branch_id)).coaches++; });
            paidRows.forEach((p: any) => { bucket(keyOf(p.branch_id)).income += receivedAmount(p); });

            const sedes: { id: string; name: string; students: number; coaches: number; income: number }[] =
                schoolBranches
                    .filter(b => !branchFilterId || b.id === branchFilterId)
                    .map(b => ({ id: b.id, name: b.name, ...(tally.get(b.id) ?? { students: 0, coaches: 0, income: 0 }) }));
            // Fila «Sin sede»: lo que no tiene sede en una escuela multisede. Solo
            // sin filtro de sede (con una sede elegida, lo sin sede no se reparte).
            const sinSede = tally.get(NO_BRANCH);
            if (!branchFilterId && sinSede && (sinSede.students || sinSede.coaches || sinSede.income)) {
                sedes.push({ id: 'sin_sede', name: SIN_SEDE, ...sinSede });
            }

            // 5. Teams
            let teamsQuery = supabase
                .from('teams')
                .select('id, name, price_monthly, description')   // monthly_fee no existe en teams
                .eq('school_id', schoolId)
                // La sección del panel se llama "Equipos Activos": un equipo dado
                // de baja no debe contarse ni listarse ahí.
                .eq('active', true);

            if (branchFilterId) teamsQuery = teamsQuery.eq('branch_id', branchFilterId);

            const { data: teamsData, error: teamsErr } = await teamsQuery;
            if (teamsErr) throw teamsErr;

            const teams = await Promise.all(
                (teamsData || []).map(async (p: any) => {
                    const { count } = await supabase
                        .from('children')
                        .select('id', { count: 'exact', head: true })
                        .eq('team_id', p.id);
                    const fee = Number(p.price_monthly) || 0;
                    return {
                        id: p.id,
                        name: p.name,
                        students: count || 0,
                        monthly_fee: fee,
                        revenue: (count || 0) * fee,
                    };
                })
            );

            // 6. Planes — lista completa de la escuela (independiente del filtro
            // aplicado) para poblar el selector "Filtrar por plan".
            const { data: plansData, error: plansErr } = await supabase
                .from('offering_plans')
                .select('id, name')
                .eq('school_id', schoolId)
                .eq('is_active', true)
                .order('name');
            if (plansErr) throw plansErr;
            const plans = (plansData || []).map((p: any) => ({ id: p.id, name: p.name }));

            // `revenue_potential` y `athletes_active` van aparte de `students` a
            // propósito: la lista está capada a 500 filas y ningún KPI puede depender
            // de cuántas quepan.
            return res.json({
                students,
                payments,
                coaches,
                sedes,
                teams,
                plans,
                revenue_potential: revenuePotential,
                athletes_active: athletesInScope.length,
            });

        } catch (err: any) {
            req.log?.error({ err: err.message || err }, 'Error en reporte de dashboard');
            return res.status(500).json({ error: 'Error interno obteniendo el dashboard.' });
        }
    }
);

// ── GET /api/v1/reports/coach/:teamId ─────────────────────────────────────────
router.get(
    '/coach/:teamId',
    requireAuth,
    requireRole('owner', 'super_admin', 'admin', 'auditor', 'reporter', 'coach', 'staff', 'school_admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const { teamId } = req.params;
            const { schoolId } = req;

            // Service role: este es el único gate. Antes solo se validaba la
            // escuela para school_admin → cualquier coach/owner leía equipos de
            // otra escuela por UUID. Ver services/team-access.service.ts.
            const acceso = await resolverAccesoEquipo<{
                id: string; name: string; age_group: string | null; sport: string | null;
                coach_id: string | null; school_id: string | null;
            }>(supabase, { role: req.role, schoolId, userId: req.user?.id }, String(teamId));
            if (!acceso.ok) return res.status(acceso.status).json({ error: acceso.error });
            const team = acceso.team;

            // Roster
            const { data: roster, error: rosterErr } = await supabase
                .from('team_members')
                .select('id, player_name, player_number, position, profile_id')
                .eq('team_id', teamId);

            if (rosterErr) throw rosterErr;

            // Match results — el deporte decide si usa sets (jsonb) o marcador plano (match_results)
            let usesSets = false;
            if (team.sport) {
                const { data: sportCat } = await supabase
                    .from('sports_categories')
                    .select('uses_sets_scoring')
                    .ilike('name', team.sport)
                    .maybeSingle();
                usesSets = sportCat?.uses_sets_scoring ?? false;
            }
            let results: any[] = [];

            if (usesSets) {
                const { data: compResults, error: resultsErr } = await supabase
                    .from('competition_results')
                    .select('id, competition_date, result_type, result_data, opponent, notes')
                    .eq('team_id', teamId)
                    .order('competition_date', { ascending: false });

                if (resultsErr) throw resultsErr;

                results = (compResults || []).map((r: any) => {
                    const rData = r.result_data || {};
                    const sets = rData.sets || [];
                    const setsWonTeam = rData.sets_won_team || 0;
                    const setsWonOpponent = rData.sets_won_opponent || 0;

                    const setsStr = sets
                        .map((s: any) => `${s.team_score}-${s.opponent_score}`)
                        .join(', ');
                    const score = sets.length > 0
                        ? `${setsWonTeam} - ${setsWonOpponent} (${setsStr})`
                        : null;

                    return {
                        id: r.id,
                        match_date: r.competition_date,
                        opponent: r.opponent,
                        result: rData.match_result || 'unknown',
                        score,
                        match_type: r.result_type === 'competencia_oficial' ? 'Competencia' : 'Amistoso',
                        notes: r.notes
                    };
                });
            } else {
                const { data: matchResults, error: resultsErr } = await supabase
                    .from('match_results')
                    .select('*')
                    .eq('team_id', teamId)
                    .order('match_date', { ascending: false });

                if (resultsErr) throw resultsErr;
                // match_results no guarda el desenlace: se deriva del marcador.
                // home_score es el del LOCAL (no el nuestro) — misma regla que
                // ResultsPage. Sin esto todo salía "Programado" y los KPIs en 0.
                results = (matchResults || []).map((m: any) => {
                    const nuestro = m.is_home === false ? m.away_score : m.home_score;
                    const rival = m.is_home === false ? m.home_score : m.away_score;
                    if (m.status !== 'played' || nuestro == null || rival == null) {
                        return { ...m, result: 'unknown' };
                    }
                    return {
                        ...m,
                        result: nuestro > rival ? 'win' : nuestro < rival ? 'loss' : 'draw',
                        score: `${nuestro} - ${rival}`,
                    };
                });
            }

            // Attendance
            const { data: attendance, error: attendanceErr } = await supabase
                .from('attendance_records')
                .select('status, child_id')
                .eq('team_id', teamId);

            if (attendanceErr) throw attendanceErr;

            const attendanceByPlayer: Record<string, { present: number; total: number }> = {};
            (attendance || []).forEach((record: any) => {
                if (!attendanceByPlayer[record.child_id]) {
                    attendanceByPlayer[record.child_id] = { present: 0, total: 0 };
                }
                attendanceByPlayer[record.child_id].total++;
                if (record.status === 'present' || record.status === 'late') {
                    attendanceByPlayer[record.child_id].present++;
                }
            });

            // Obtener child_ids únicos desde los registros de asistencia
            const childIds = [...new Set((attendance || []).map((r: any) => r.child_id).filter(Boolean))];

            let children: any[] = [];
            if (childIds.length > 0) {
                const { data: childrenData } = await supabase
                    .from('children')
                    .select('id, full_name')
                    .in('id', childIds);
                children = childrenData || [];
            }

            const attendanceReport = (children || []).map((child: any) => {
                const stat = attendanceByPlayer[child.id];
                return {
                    name: child.full_name,
                    percentage: stat && stat.total > 0
                        ? Math.round((stat.present / stat.total) * 100)
                        : 0,
                };
            }).sort((a: any, b: any) => b.percentage - a.percentage);

            const playedResults = results.filter((r: any) => r.result !== 'unknown');

            // Goleadores: el coach carga «goles» y «asistencias» como métrica
            // (performance_entries) con aggregation 'latest' — cada registro es
            // el ACUMULADO de la temporada, así que vale el último por atleta,
            // no la suma. Plantel = inscripciones activas del equipo.
            const { data: inscritos } = await supabase
                .from('enrollments')
                .select('child_id, user_id, unregistered_athlete_id')
                .eq('team_id', teamId)
                .eq('status', 'active');

            const sujetos = new Map<string, 'child' | 'profile' | 'unregistered'>();
            (inscritos || []).forEach((e: any) => {
                if (e.child_id) sujetos.set(e.child_id, 'child');
                else if (e.user_id) sujetos.set(e.user_id, 'profile');
                else if (e.unregistered_athlete_id) sujetos.set(e.unregistered_athlete_id, 'unregistered');
            });

            let scorers: { name: string; goals: number; assists: number }[] = [];
            if (sujetos.size > 0) {
                const ids = [...sujetos.keys()];
                const inicioTemporada = `${new Date().getFullYear()}-01-01`;
                const { data: entradas } = await supabase
                    .from('performance_entries')
                    .select('subject_id, metric_key, value, recorded_at')
                    .eq('school_id', team.school_id)
                    .in('metric_key', ['goles', 'asistencias'])
                    .in('subject_id', ids)
                    .gte('recorded_at', inicioTemporada)
                    .order('recorded_at', { ascending: true });

                const ultimo: Record<string, { goals: number; assists: number }> = {};
                (entradas || []).forEach((pe: any) => {
                    const fila = (ultimo[pe.subject_id] ??= { goals: 0, assists: 0 });
                    if (pe.metric_key === 'goles') fila.goals = Number(pe.value) || 0;
                    else fila.assists = Number(pe.value) || 0;
                });

                const conDatos = Object.keys(ultimo);
                if (conDatos.length > 0) {
                    const porTipo = (t: string) => conDatos.filter((id) => sujetos.get(id) === t);
                    const [ch, pr, un] = await Promise.all([
                        porTipo('child').length
                            ? supabase.from('children').select('id, full_name').in('id', porTipo('child'))
                            : Promise.resolve({ data: [] as any[] }),
                        porTipo('profile').length
                            ? supabase.from('profiles').select('id, full_name').in('id', porTipo('profile'))
                            : Promise.resolve({ data: [] as any[] }),
                        porTipo('unregistered').length
                            ? supabase.from('unregistered_athletes').select('id, full_name').in('id', porTipo('unregistered'))
                            : Promise.resolve({ data: [] as any[] }),
                    ]);
                    const nombres = new Map<string, string>();
                    [...(ch.data || []), ...(pr.data || []), ...(un.data || [])].forEach((n: any) =>
                        nombres.set(n.id, (n.full_name || '').trim()),
                    );

                    scorers = conDatos
                        .map((id) => ({ name: nombres.get(id) || '—', ...ultimo[id] }))
                        .filter((s) => s.goals > 0 || s.assists > 0)
                        .sort((a, b) => b.goals - a.goals || b.assists - a.assists);
                }
            }

            return res.json({
                team: { id: team.id, name: team.name, age_group: team.age_group, sport: team.sport },
                roster: roster || [],
                results: results || [],
                results_played_count: playedResults.length,
                attendance: attendanceReport,
                scorers,
            });

        } catch (err: any) {
            req.log?.error({ err: err.message || err }, 'Error en reporte de coach');
            return res.status(500).json({ error: 'Error interno obteniendo reporte del equipo.' });
        }
    }
);

// ── GET /api/v1/reports/school/documents ─────────────────────────────────────
// Returns students + their identity document paths, filterable by team or plan.
router.get(
    '/school/documents',
    requireAuth,
    requireRole('owner', 'super_admin', 'admin', 'auditor', 'reporter', 'school_admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const { schoolId } = req;
            const branchFilterId = getBranchFilter(req);
            const teamId = req.query.team_id as string | undefined;
            const planId = req.query.offering_plan_id as string | undefined;

            // 1. Fetch children with document URL
            let childrenQuery = supabase
                .from('children')
                // NOTA: children NO tiene columna `status` en la BD; el default
                // se resuelve abajo con `child.status || 'active'`.
                .select('id, full_name, team_id, branch_id, id_document_url')
                .eq('school_id', schoolId)
                .order('full_name');

            if (branchFilterId) childrenQuery = childrenQuery.eq('branch_id', branchFilterId);
            if (teamId) childrenQuery = childrenQuery.eq('team_id', teamId);

            const { data: childrenRaw, error: childrenErr } = await childrenQuery;
            if (childrenErr) throw childrenErr;

            let childIds = (childrenRaw || []).map((c: any) => c.id);

            // 2. If filtering by plan, narrow down to children enrolled in that plan
            if (planId && childIds.length > 0) {
                const { data: enrollments, error: enrollErr } = await supabase
                    .from('enrollments')
                    .select('child_id')
                    .eq('offering_plan_id', planId)
                    .in('child_id', childIds);

                if (enrollErr) throw enrollErr;

                const enrolledChildIds = new Set((enrollments || []).map((e: any) => e.child_id));
                childIds = childIds.filter((id: string) => enrolledChildIds.has(id));
            }

            // 3. Resolve team names
            const teamIds = [...new Set((childrenRaw || []).map((c: any) => c.team_id).filter(Boolean))];
            const teamNameMap = new Map<string, string>();
            if (teamIds.length > 0) {
                const { data: teamRows } = await supabase
                    .from('teams')
                    .select('id, name')
                    .in('id', teamIds);
                (teamRows || []).forEach((t: any) => teamNameMap.set(t.id, t.name));
            }

            // 4. Resolve plan names for each child via enrollments
            const childPlanMap = new Map<string, string>();
            if (childIds.length > 0) {
                const { data: allEnrollments } = await supabase
                    .from('enrollments')
                    .select('child_id, offering_plan_id')
                    .in('child_id', childIds)
                    .eq('status', 'active');

                const planIds = [...new Set((allEnrollments || []).map((e: any) => e.offering_plan_id).filter(Boolean))];
                if (planIds.length > 0) {
                    const { data: planRows } = await supabase
                        .from('offering_plans')
                        .select('id, name')
                        .in('id', planIds);
                    const planNameMap = new Map<string, string>();
                    (planRows || []).forEach((p: any) => planNameMap.set(p.id, p.name));
                    (allEnrollments || []).forEach((e: any) => {
                        if (e.offering_plan_id && planNameMap.has(e.offering_plan_id)) {
                            childPlanMap.set(e.child_id, planNameMap.get(e.offering_plan_id)!);
                        }
                    });
                }
            }

            // 5. For each child with documents, list files from storage
            const childIdSet = new Set(childIds);
            const students = await Promise.all(
                (childrenRaw || [])
                    .filter((c: any) => childIdSet.has(c.id))
                    .map(async (child: any) => {
                        const documents: { name: string; path: string }[] = [];

                        // Try listing files from storage bucket
                        const folderPath = `children/${child.id}/docs`;
                        const { data: files } = await supabase.storage
                            .from('identity-documents')
                            .list(folderPath, { limit: 20 });

                        if (files && files.length > 0) {
                            files.forEach((f: any) => {
                                if (f.name && !f.name.startsWith('.')) {
                                    documents.push({
                                        name: f.name,
                                        path: `${folderPath}/${f.name}`,
                                    });
                                }
                            });
                        }

                        return {
                            id: child.id,
                            full_name: child.full_name || 'Sin nombre',
                            team_name: teamNameMap.get(child.team_id) || '—',
                            plan_name: childPlanMap.get(child.id) || '—',
                            status: child.status || 'active',
                            has_document: documents.length > 0,
                            documents,
                        };
                    })
            );

            return res.json({ students });

        } catch (err: any) {
            req.log?.error({ err: err.message || err }, 'Error en reporte de documentos');
            return res.status(500).json({ error: 'Error interno obteniendo documentos.' });
        }
    }
);

// ── Informe de cartera (morosos, pendientes, inactivos) ─────────────────────
// Misma lógica que el correo semanal (services/informe-cartera.service). Lo
// usa Finanzas → Cartera: «Descargar informe» (CSV para Excel) y el
// interruptor del correo de los lunes.
const ROLES_CARTERA = ['owner', 'super_admin', 'admin', 'school_admin', 'auditor', 'reporter'] as const;

router.get(
    '/school/cartera',
    requireAuth,
    requireRole(...ROLES_CARTERA),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(400).json({ error: 'Falta la escuela (x-school-id).' });
            const [informe, ajuste] = await Promise.all([
                armarInformeCartera(req.schoolId),
                leerAjusteInforme(req.schoolId),
            ]);
            res.json({ informe, ajuste, csv: informeACsv(informe), archivo: `cartera-${informe.hoy}.csv` });
        } catch (error) {
            next(error);
        }
    }
);

router.get(
    '/school/cartera/ajuste',
    requireAuth,
    requireRole(...ROLES_CARTERA),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(400).json({ error: 'Falta la escuela (x-school-id).' });
            res.json({ ajuste: await leerAjusteInforme(req.schoolId) });
        } catch (error) {
            next(error);
        }
    }
);

router.put(
    '/school/cartera/ajuste',
    requireAuth,
    requireRole('owner', 'super_admin', 'admin', 'school_admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(400).json({ error: 'Falta la escuela (x-school-id).' });
            const v = req.body?.enabled;
            if (v !== true && v !== false && v !== null) {
                return res.status(400).json({ error: 'enabled debe ser true, false o null (automático).' });
            }
            await guardarAjusteInforme(req.schoolId, v);
            res.json({ ajuste: await leerAjusteInforme(req.schoolId) });
        } catch (error: any) {
            if (/cartera_report_enabled/.test(error?.message ?? '')) {
                return res.status(409).json({ error: 'El ajuste todavía no está disponible (falta aplicar la migración 20261007182206).' });
            }
            next(error);
        }
    }
);

export default router;
