import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { emailClient } from '@/lib/email-client';
import { bffClient } from '@/lib/api/bffClient';
import { normalizeText } from '@/lib/normalizeText';
import { nombresParecidos } from '@/lib/nombreParecido';
import { readStoredContextKey, fetchRoleContexts } from '@/lib/roleContexts';
import { OFFLINE_ENABLED } from '@/lib/offline/offlineConfig';
import { guardarCopiaArranque, leerCopiaArranque, leerSesionGuardada } from '@/lib/offline/arranqueSinRed';

/**
 * Represents a sports team or group offered by a school.
 */
export interface SchoolTeam {
    id: string;
    name: string;
    monthly_fee: number;
    sport_type?: string;
    branch_id?: string;
}

/**
 * Represents a user's role and membership within a specific school or branch.
 */
export interface SchoolRole {
    schoolId: string;
    schoolName: string;
    // `external_vendor` y `personal_trainer` ya se usan en AppSidebar y en los
    // guards, pero faltaban aca: el switch por rol no compilaba contra este union.
    role: 'owner' | 'admin' | 'super_admin' | 'school_admin' | 'school' | 'coach' | 'staff' | 'parent' | 'athlete' | 'viewer' | 'wellness_professional' | 'store_owner' | 'external_vendor' | 'personal_trainer' | 'organizer' | 'reporter' | 'accountant';
    branchId: string | null;
    isGlobal?: boolean; // If true, the user has school-wide access
    onboardingStatus?: 'pending' | 'in_progress' | 'completed';
    schoolType?: string;
}

/**
 * The state and methods provided by the School Context.
 */
export interface SchoolContext {
    /** The ID of the currently active school. */
    schoolId: string | null;
    /** The name of the currently active school. */
    schoolName: string;
    /** The role of the current user in the active school. */
    currentUserRole: SchoolRole['role'] | null;
    /** List of teams/groups available in the active school/branch. */
    teams: SchoolTeam[];
    /** List of all schools the user is a member of. */
    availableSchools: SchoolRole[];
    /** The ID of the currently active branch (null for all branches). */
    activeBranchId: string | null;
    /** The display name of the currently active branch. */
    activeBranchName: string;
    /** Current onboarding state of the active school. */
    onboardingStatus: 'pending' | 'in_progress' | 'completed';
    /** Raw configuration settings for the school. */
    schoolSettings: any | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    /** Updates the overall onboarding status in the database. */
    updateOnboardingStatus: (status: 'pending' | 'in_progress' | 'completed') => Promise<boolean>;
    /** Updates the specific step index in the onboarding wizard. */
    updateOnboardingStep: (step: number) => Promise<void>;
    /** Switches the active context to another school/branch. */
    /** Whether the user has global permissions for the current school. */
    isGlobalAdmin: boolean;
    /** Total number of branches in the active school. */
    totalBranches: number;
    /** All branches for the current active school (principal primero, luego por nombre). */
    branches: { id: string; name: string; status?: string | null; is_main?: boolean | null }[];
    /** Switches the active context to another school/branch. */
    switchSchool: (schoolId: string, branchId?: string | null) => void;
    /** Default fee to use if no program price is found. */
    defaultMonthlyFee: number;
    /** Whether the context is currently loading data. */
    loading: boolean;
    /** Error message if any operation failed. */
    error: string | null;
    /** Branding settings de la escuela activa (logo, colores) */
    schoolBranding: {
        logo_url: string | null
        branding_settings: {
            primary_color: string
            secondary_color: string
            show_sportmaps_watermark: boolean
        } | null
    } | null;
    /** Recarga los datos de branding sin recargar toda la página */
    refreshSchoolBranding: () => Promise<void>;
}

const SchoolContext = createContext<SchoolContext | undefined>(undefined);

// Email de la escuela demo para usuarios invitados (solo si se configura en .env)
const DEMO_SCHOOL_EMAIL = import.meta.env.VITE_DEMO_SCHOOL_EMAIL || '';
// Sin cuota configurada NO se inventa una. Antes valía $150.000 y ese monto se
// colaba como precargado en el alta, en la invitación y en el cobro: el atleta
// nacía debiendo una mensualidad que la escuela nunca definió. Mismo criterio
// que el alta canónica del BFF (students-create-one): sin cuota, sin cobro.
const DEFAULT_MONTHLY_FEE = 0; // COP
const STORAGE_KEY_ACTIVE_SCHOOL = 'sportmaps_active_school_id';

/**
 * Internal hook that manages the school context state.
 */
function useSchoolContextManager(): SchoolContext {
    const [activeSchoolId, setActiveSchoolId] = useState<string | null>(null);
    const [activeSchoolName, setActiveSchoolName] = useState('Escuela');
    const [currentUserRole, setCurrentUserRole] = useState<SchoolRole['role'] | null>(null);

    const [availableSchools, setAvailableSchools] = useState<SchoolRole[]>([]);
    const [teams, setTeams] = useState<SchoolTeam[]>([]);
    const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
    const [activeBranchName, setActiveBranchName] = useState('Todas las sedes');
    const [onboardingStatus, setOnboardingStatus] = useState<'pending' | 'in_progress' | 'completed'>('completed');
    const [schoolSettings, setSchoolSettings] = useState<any | null>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
    const [schoolBranding, setSchoolBranding] = useState<SchoolContext['schoolBranding']>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isGlobalAdmin, setIsGlobalAdmin] = useState(false);
    const [totalBranchesCount, setTotalBranchesCount] = useState(0);
    const [branches, setBranches] = useState<{ id: string; name: string; status?: string | null; is_main?: boolean | null }[]>([]);
    const [resolveCounter, setResolveCounter] = useState(0);
    // Modo offline: las escuelas salieron de la copia del último arranque (no de la base).
    // Al volver la red se resuelve de nuevo, EN SILENCIO (sin `loading`, que desmontaría el árbol).
    const arrancoDesdeCopiaRef = useRef(false);
    const resolverEnSilencioRef = useRef(false);

    const queryClient = useQueryClient();

    // Track the current user ID to detect user changes
    const currentUserIdRef = useRef<string | null>(null);
    // Track the previous school ID so we can invalidate stale caches on switch
    const previousSchoolIdRef = useRef<string | null>(null);

    // Reset all school state (called on sign-out or user change)
    const resetState = useCallback((clearQueryCache: boolean = true) => {
        setActiveSchoolId(null);
        setActiveSchoolName('Escuela');
        setCurrentUserRole(null);
        setAvailableSchools([]);
        setTeams([]);
        setActiveBranchId(null);
        setActiveBranchName('Todas las sedes');
        setOnboardingStatus('completed');
        setSchoolSettings(null);
        setSchoolBranding(null);
        setIsGlobalAdmin(false);
        setTotalBranchesCount(0);
        setBranches([]);
        setError(null);
        currentUserIdRef.current = null;
        previousSchoolIdRef.current = null;
        // Defensive: clear module-level BFF header and query cache so
        // subsequent renders never hit the previous user's tenant.
        bffClient.setSchoolId(null);
        if (clearQueryCache) queryClient.clear();
    }, [queryClient]);

    // 1. Initial Load: Resolve User & Memberships
    useEffect(() => {
        const resolveFallbackSchool = async () => {
            // Safety Check: Only run fallback if configured explicitly
            if (!DEMO_SCHOOL_EMAIL) {
                console.log('Guest mode: No VITE_DEMO_SCHOOL_EMAIL configured. Fallback disabled.');
                setLoading(false);
                return;
            }

            // Only for unauthenticated guests, try to find the official Demo School
            const { data: demoSchool } = await supabase
                .from('schools')
                .select('id, name')
                .eq('email', DEMO_SCHOOL_EMAIL)
                .maybeSingle();

            if (demoSchool) {
                setActiveSchoolId(demoSchool.id);
                setActiveSchoolName(demoSchool.name);
                setCurrentUserRole('viewer');
                setAvailableSchools([{ schoolId: demoSchool.id, schoolName: demoSchool.name, role: 'viewer', branchId: null, onboardingStatus: 'completed' }]);
            } else {
                console.log('No demo school found for guest.');
            }
            // Start fetch teams immediately for fallback
            if (activeSchoolId) fetchTeams(activeSchoolId);
        };

        const resolveUserContext = async () => {
            try {
                if (!resolverEnSilencioRef.current) setLoading(true);
                resolverEnSilencioRef.current = false;
                let { data: { user } } = await supabase.auth.getUser();
                // Sin red getUser() (valida contra el servidor) devuelve null aunque la sesión siga
                // guardada: se usa la guardada para no tratar a la persona como visitante.
                if (!user) {
                    const guardada = leerSesionGuardada();
                    if (guardada) user = guardada.user as unknown as typeof user;
                }

                if (!user) {
                    // Fallback: Try to find Default Demo School if no user (Guest Mode)
                    await resolveFallbackSchool();
                    return;
                }

                // Ensure we know the user's base profile role BEFORE mapping memberships
                const { data: userProfile } = await supabase
                    .from('profiles')
                    .select('role')
                    .eq('id', user.id)
                    .maybeSingle();

                // Fetch memberships
                const { data: memberships, error: memberError } = await supabase
                    .from('school_members')
                    .select('school_id, role, branch_id, schools(id, name, onboarding_status, school_type)')
                    .eq('profile_id', user.id)
                    .eq('status', 'active');

                // Sin red: las escuelas de la última vez que se resolvieron con éxito.
                const copiaEscuelas = memberError ? leerCopiaArranque<SchoolRole[]>('escuelas', user.id) : null;
                if (memberError && !copiaEscuelas) throw memberError;
                if (copiaEscuelas) arrancoDesdeCopiaRef.current = true;

                // Persona multirol: el rol elegido en el selector (lib/roleContexts.ts)
                // manda en SU escuela. Este provider corre EN PARALELO con AuthContext,
                // así que no puede confiar en que ya validó la clave: una elección vieja
                // (p. ej. 'parent:<escuela>' de alguien que ya no tiene hijos inscritos
                // y quedó con un solo rol) le aplicaría 'parent' a un dueño en su propia
                // escuela, sin selector para salir. Se valida aquí contra los mismos
                // datos; solo cuesta consultas a quien tiene una elección guardada.
                let ctxRole = '';
                let ctxSchoolId = '';
                const storedCtxKey = readStoredContextKey(user.id);
                if (storedCtxKey) {
                    const contexts = await fetchRoleContexts(user.id, userProfile?.role ?? undefined);
                    if (contexts.some((c) => c.key === storedCtxKey)) {
                        [ctxRole, ctxSchoolId] = storedCtxKey.split(':');
                    }
                }

                if (copiaEscuelas ? copiaEscuelas.length > 0 : (memberships && memberships.length > 0)) {
                    const mappedSchools: SchoolRole[] = copiaEscuelas ?? memberships!.map((m: any) => {
                        // Owners and super_admins are ALWAYS global, regardless of branch_id
                        const isAlwaysGlobal = m.role === 'owner' || m.role === 'super_admin';
                        // school_admin and admin are global only if they have no branch_id set
                        const isScopedAdmin = (m.role === 'admin' || m.role === 'school_admin') && !m.branch_id;

                        return {
                            schoolId: m.school_id,
                            schoolName: m.schools?.name || 'Escuela sin nombre',
                            schoolType: m.schools?.school_type || 'academy',
                            // En la escuela del rol elegido: familia → el rol elegido;
                            // staff → la membresía tal cual (sin forzar 'parent').
                            // Fuera de eso, como antes: si el perfil es padre se fuerza
                            // "parent" para que membresías erróneas de "athlete" no
                            // sobrescriban su Dashboard.
                            role: (ctxRole && m.school_id === ctxSchoolId)
                                ? ((ctxRole === 'parent' || ctxRole === 'athlete') ? ctxRole : (m.role as SchoolRole['role']))
                                : (userProfile?.role === 'parent') ? 'parent' : (m.role as SchoolRole['role']),
                            // Owners and super admins manage the whole school, they shouldn't be tied to a specific branch on load if they have a global role
                            branchId: isAlwaysGlobal ? null : (m.branch_id || null),
                            isGlobal: isAlwaysGlobal || isScopedAdmin,
                            onboardingStatus: (m.schools?.onboarding_status as SchoolContext['onboardingStatus']) || 'completed'
                        };
                    });

                    setAvailableSchools(mappedSchools);
                    if (!copiaEscuelas) {
                        arrancoDesdeCopiaRef.current = false;
                        guardarCopiaArranque<SchoolRole[]>('escuelas', user.id, mappedSchools);
                    }

                    // Determine active school
                    const storedId = localStorage.getItem(STORAGE_KEY_ACTIVE_SCHOOL);
                    const found = mappedSchools.find(s => s.schoolId === storedId);

                    if (found) {
                        selectSchool(found);
                    } else {
                        // Selección inicial determinista (sin localStorage previo).
                        // La query de school_members no garantiza orden, así que
                        // NO tomar "la primera" al azar: se ordena por criterio.
                        //  1) Rol: donde el usuario administra (owner/admin) pesa más
                        //     que donde solo participa (parent/athlete). Evita caer en
                        //     una escuela ajena/demo cuando el usuario es dueño de otra.
                        //  2) Academia antes que otros tipos (preserva "academia > PT"
                        //     para atletas con doble membresía).
                        //  3) Nombre como desempate estable (determinista entre requests).
                        const ROLE_PRIORITY: Record<string, number> = {
                            owner: 0, super_admin: 1, school_admin: 2, admin: 3,
                            coach: 4, accountant: 5, reporter: 5, viewer: 6, parent: 7, athlete: 8,
                        };
                        const rank = (r: string) => ROLE_PRIORITY[r] ?? 99;
                        const preferredSchool =
                            [...mappedSchools].sort((a, b) => {
                                const byRole = rank(a.role) - rank(b.role);
                                if (byRole !== 0) return byRole;
                                const aAcademy = a.schoolType === 'academy' ? 0 : 1;
                                const bAcademy = b.schoolType === 'academy' ? 0 : 1;
                                if (aAcademy !== bAcademy) return aAcademy - bAcademy;
                                return a.schoolName.localeCompare(b.schoolName);
                            })[0] ?? mappedSchools[0];
                        selectSchool(preferredSchool);
                    }
                } else {
                    // Authenticated but no memberships
                    // Check if user is explicitly a SCHOOL role
                    const userRole = userProfile?.role as string;
                    if (userRole === 'school' || userRole === 'school_admin' || userRole === 'reporter') {
                        // New School Owner -> Trigger Onboarding
                        console.log('User is SCHOOL role with no memberships. Triggering Onboarding state.');
                        setAvailableSchools([]);
                        setActiveSchoolId(null);
                        setActiveSchoolName('Mi Escuela');
                        setCurrentUserRole('owner');
                        setOnboardingStatus('pending');
                    } else {
                        // Parent/Athlete/Coach without school membership yet
                        console.log(`User is ${userProfile?.role || 'unknown'} role. Skipping School Context logic.`);
                        setAvailableSchools([]);
                        setActiveSchoolId(null);
                        setActiveSchoolName('');
                        setCurrentUserRole(null);
                        setOnboardingStatus('completed'); // Bypass School Gate
                    }
                }
            } catch (err: unknown) {
                console.error('useSchoolContext resolution error:', err);
                setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
                setLoading(false);
            }
        };

        resolveUserContext();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolveCounter]);

    // 1a. Modo offline: volvió la red tras arrancar con la copia → se resuelve de nuevo, en silencio.
    useEffect(() => {
        if (!OFFLINE_ENABLED) return;
        const alVolverLaRed = () => {
            if (!arrancoDesdeCopiaRef.current) return;
            arrancoDesdeCopiaRef.current = false;
            resolverEnSilencioRef.current = true;
            setResolveCounter((c) => c + 1);
        };
        window.addEventListener('online', alVolverLaRed);
        return () => window.removeEventListener('online', alVolverLaRed);
    }, []);

    // 1b. Listen for auth changes to reset state on sign-out / re-resolve on new sign-in
    useEffect(() => {
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            // Sin red y con el token vencido llega INITIAL_SESSION sin sesión aunque la sesión SIGA
            // guardada: no es un cierre de sesión, no se borran las escuelas ya resueltas.
            if (event !== 'SIGNED_OUT' && !session && leerSesionGuardada()) return;
            if (event === 'SIGNED_OUT' || !session?.user) {
                // INITIAL_SESSION sin sesión = visitante anónimo que recién
                // carga: no hay datos de otro usuario que borrar, y clear()
                // destruía las queries EN VUELO (cancelación silenciosa) y
                // dejaba colgado a quien ya las observaba: StoreGate quedaba
                // en spinner para siempre en la vitrina pública /tienda/:slug.
                resetState(event !== 'INITIAL_SESSION');
            } else if (event === 'SIGNED_IN' && session?.user) {
                // Only re-resolve if the user actually changed
                if (currentUserIdRef.current !== session.user.id) {
                    currentUserIdRef.current = session.user.id;
                    // Mostrar spinner y re-resolver contexto para el nuevo usuario
                    setLoading(true);
                    setResolveCounter(c => c + 1);
                }
            }
        });

        return () => subscription.unsubscribe();
    }, [resetState]);


    const selectSchool = useCallback(async (school: SchoolRole) => {
        const previousSchoolId = previousSchoolIdRef.current;
        const isSwitch = previousSchoolId && previousSchoolId !== school.schoolId;

        // Update BFF header synchronously so any query fired mid-render hits
        // the right tenant (don't wait for the useEffect on activeSchoolId).
        bffClient.setSchoolId(school.schoolId);

        setActiveSchoolId(school.schoolId);
        setActiveSchoolName(school.schoolName);
        setCurrentUserRole(school.role);
        setActiveBranchId(school.branchId);
        setIsGlobalAdmin(!!school.isGlobal);

        // When switching to a different school, purge any cached query whose
        // key references the old schoolId. Prevents the UI from flashing stale
        // data for a few ms while the new queries refetch.
        if (isSwitch) {
            queryClient.removeQueries({
                predicate: (query) => query.queryKey.some(
                    (k) => typeof k === 'string' && k === previousSchoolId
                ),
            });
            // Force refetch of active school-scoped queries so data appears ASAP.
            queryClient.invalidateQueries({ refetchType: 'active' });
        }

        previousSchoolIdRef.current = school.schoolId;

        // Fetch branch count and data (for display purposes)
        const { data: branchesData, count } = await supabase
            .from('school_branches')
            .select('id, name, status, is_main', { count: 'exact' })
            .eq('school_id', school.schoolId)
            .order('is_main', { ascending: false })
            .order('name', { ascending: true });

        setTotalBranchesCount(count || 0);
        setBranches(branchesData || []);

        if (school.branchId) {
            const branch = branchesData?.find(b => b.id === school.branchId);
            setActiveBranchName(branch?.name || 'Sede');
        } else {
            // branchId null = owner/admin global mirando TODAS las sedes (selector
            // multisede del menú lateral). No es «la sede principal».
            setActiveBranchName('Todas las sedes');
        }

        setOnboardingStatus(school.onboardingStatus || 'completed');
        // Clear branding when switching schools to avoid "flash" of previous branding.
        // Solo si cambia la ESCUELA: cambiar de sede (selector multisede) no
        // re-dispara fetchSchoolBranding (depende de activeSchoolId), así que
        // limpiarla aquí dejaba la escuela sin marca hasta recargar.
        if (previousSchoolId !== school.schoolId) setSchoolBranding(null);
        localStorage.setItem(STORAGE_KEY_ACTIVE_SCHOOL, school.schoolId);
    }, [queryClient]);

    const switchSchool = (schoolId: string, branchId: string | null = null) => {
        // First try exact match
        const target = availableSchools.find(s => s.schoolId === schoolId && s.branchId === branchId);
        if (target) {
            selectSchool(target);
            return;
        }

        // For global admins (owner/super_admin), they have a single entry with branchId=null
        // When they select a specific branch, we create a synthetic SchoolRole with that branchId
        const baseEntry = availableSchools.find(s => s.schoolId === schoolId && s.isGlobal);
        if (baseEntry) {
            selectSchool({
                ...baseEntry,
                branchId: branchId, // null = "Todas las sedes", UUID = specific sede
            });
            return;
        }

        // Last resort: find any entry in that school
        const anyInSchool = availableSchools.find(s => s.schoolId === schoolId);
        if (anyInSchool) selectSchool(anyInSchool);
    };

    // OJO: NO tocar `loading` aquí. `loading` es el gate de <ProtectedRoute>, que
    // desmonta TODO el árbol autenticado mientras esté en true. Como este fetch
    // corre en un efecto DESPUÉS de que resolveUserContext ya puso loading=false,
    // ponerlo en true otra vez desmontaba y remontaba AuthLayout entero: cada
    // query y cada efecto de la app se disparaba dos veces por login.
    // `loading` = "aún no resolví el contexto base", nada más.
    const fetchTeams = useCallback(async (id: string, branchId: string | null = null) => {
        if (!id || id === "") return;
        try {
            let query = supabase
                .from('teams')
                .select('id, name, price_monthly, sport, branch_id')
                .eq('school_id', id);

            if (branchId) {
                query = query.eq('branch_id', branchId);
            }

            const { data: teamsData } = await query;

            if (teamsData) {
                setTeams(
                    teamsData.map((p: any) => ({
                        id: p.id,
                        name: p.name,
                        // Equipo sin precio configurado = cuota 0. Antes caía en
                        // DEFAULT_MONTHLY_FEE e inyectaba una mensualidad
                        // fantasma en inscripciones e invitaciones.
                        monthly_fee: p.price_monthly ?? 0,
                        sport_type: p.sport,
                        branch_id: p.branch_id
                    }))
                );
            } else {
                setTeams([]);
            }
        } catch (e) {
            console.error(e);
        }
    }, []);

    const fetchSettings = useCallback(async (id: string) => {
        if (!id || id === "") return;
        const { data } = await supabase
            .from('school_settings')
            .select('*')
            .eq('school_id', id)
            .maybeSingle();
        setSchoolSettings(data);
    }, []);

    const fetchSchoolBranding = useCallback(async (id: string) => {
        if (!id || id === "") {
            setSchoolBranding(null);
            return;
        }

        const { data } = await supabase
            .from('schools')
            .select('logo_url, branding_settings')
            .eq('id', id)
            .maybeSingle();

        if (data) {
            const schoolData = data as any;
            setSchoolBranding({
                logo_url: schoolData.logo_url ?? null,
                branding_settings: schoolData.branding_settings ?? null,
            });
        }
    }, []);

    const refreshSchoolBranding = useCallback(async () => {
        if (activeSchoolId) {
            await fetchSchoolBranding(activeSchoolId);
        }
    }, [activeSchoolId, fetchSchoolBranding]);

    const updateOnboardingStatus = async (status: 'pending' | 'in_progress' | 'completed'): Promise<boolean> => {
        if (!activeSchoolId) {
            console.error('❌ updateOnboardingStatus: No activeSchoolId found.');
            return false;
        }

        console.log(`🔄 Updating onboarding status for school ${activeSchoolId} to: ${status}`);

        try {
            const { data, error: updateError } = await supabase
                .from('schools')
                .update({ onboarding_status: status })
                .eq('id', activeSchoolId)
                .select();

            const count = data?.length || 0;

            if (updateError) {
                console.error('❌ Supabase Update Error:', updateError);
                return false;
            }

            if (count === 0) {
                console.warn(`⚠️ UPDATE returned 0 rows affected. RLS may be blocking update for school ${activeSchoolId}.`);
                return false;
            }

            console.log(`✅ Successfully updated onboarding status. Rows affected: ${count}`);

            // Only update local state if DB update succeeded
            setOnboardingStatus(status);

            // Update the complex availableSchools array in memory
            setAvailableSchools(prev => prev.map(s =>
                s.schoolId === activeSchoolId
                    ? { ...s, onboardingStatus: status }
                    : s
            ));

            return true;
        } catch (err) {
            console.error('Failed to update onboarding status (catch):', err);
            return false;
        }
    };

    const updateOnboardingStep = async (step: number) => {
        if (!activeSchoolId) return;
        try {
            await supabase
                .from('schools')
                .update({ onboarding_step: step })
                .eq('id', activeSchoolId);
        } catch (err) {
            console.error('Failed to update onboarding step:', err);
        }
    };

    // 2a. Effect: Fetch Branch-specific data (Teams)
    useEffect(() => {
        if (activeSchoolId && activeSchoolId !== "") {
            fetchTeams(activeSchoolId, activeBranchId);
        }
    }, [activeSchoolId, activeBranchId, fetchTeams]);

    // 2b. Effect: Fetch School-wide data (Settings, Branding)
    // Only happens when the school changes, NOT the branch.
    useEffect(() => {
        if (activeSchoolId && activeSchoolId !== "") {
            fetchSettings(activeSchoolId);
            fetchSchoolBranding(activeSchoolId);
        }
    }, [activeSchoolId, fetchSettings, fetchSchoolBranding]);

    // 3. Effect: Link Active School to bffClient for header injection
    useEffect(() => {
        bffClient.setSchoolId(activeSchoolId ?? null);
    }, [activeSchoolId]);

    return {
        schoolId: activeSchoolId,
        schoolName: activeSchoolName,
        currentUserRole,
        teams,
        availableSchools,
        activeBranchId,
        activeBranchName,
        onboardingStatus,
        schoolSettings,
        updateOnboardingStatus,
        updateOnboardingStep,
        switchSchool,
        isGlobalAdmin,
        totalBranches: totalBranchesCount,
        branches,
        defaultMonthlyFee: DEFAULT_MONTHLY_FEE,
        loading,
        error,
        schoolBranding,
        refreshSchoolBranding,
    };
}

/**
 * Provider component. Avoids JSX so this file stays as .ts
 */
export function SchoolProvider({ children }: { children: React.ReactNode }) {
    const value = useSchoolContextManager();
    return React.createElement(SchoolContext.Provider, { value }, children);
}

/**
 * Hook to consume the school context from any component.
 */
export function useSchoolContext(): SchoolContext {
    const context = useContext(SchoolContext);
    if (context === undefined) {
        throw new Error('useSchoolContext must be used within a <SchoolProvider>');
    }
    return context;
}

// ─── Deduplicación de atletas en el alta de staff ────────────────────────────
//
// Un atleta puede existir en la escuela como fila de `children` o como ficha en
// `unregistered_athletes`. Cuando nace por dos caminos quedan DOS identidades
// facturables y la familia recibe el cobro dos veces (48 personas duplicadas en
// 16 escuelas, con cobros que hubo que anular a mano).
//
// El guardián de la base (`trg_bloquear_atleta_duplicado`) no cubre este alta:
// solo dispara si viene el documento, o si el nombre coincide Y la fecha de
// nacimiento es IDÉNTICA — y este flujo no mandaba documento y deja la fecha
// opcional. Además solo mira `children`, nunca `unregistered_athletes`.
//
// Mismo criterio que `findExistingAthlete` del BFF
// (bff/src/routes/students-create-one.route.ts): se cruza por documento y por
// nombre normalizado, NO por teléfono ni por fecha de nacimiento — esas dos
// señales dan falsos positivos entre hermanos (las hermanas Ariza comparten
// fecha y teléfono del acudiente).

/** Mismo criterio que `normalize_athlete_name()` en la base: sin tildes, en
 *  minúsculas y con los espacios internos colapsados. `normalizeText` sola no
 *  colapsa espacios internos, y ese hueco exacto ya generó fichas duplicadas. */
function normalizarNombreAtleta(valor: string | null | undefined): string {
    return normalizeText(valor).replace(/\s+/g, ' ');
}

/** Tope explícito del padrón que se trae para comparar. Explícito para poder
 *  detectar el truncamiento; el implícito de PostgREST corta sin avisar. */
const TOPE_PADRON = 2000;

/** Mismo criterio que `normalize_doc_number()` en la base: solo alfanuméricos. */
function normalizarDocumento(valor: string | null | undefined): string | null {
    const limpio = (valor ?? '').replace(/[^0-9A-Za-z]/g, '');
    return limpio || null;
}

/**
 * ¿Un nombre está contenido en el otro como secuencia de palabras completas?
 * Cubre el caso real "Sergio Herrera" ⊂ "SERGIO HERRERA TORRES" (apellido que
 * falta en una de las dos altas). Exige 2+ palabras en el nombre corto para no
 * marcar a medio padrón por un nombre de pila suelto.
 */
function nombreContenido(a: string, b: string): boolean {
    const ta = a.split(' ').filter(Boolean);
    const tb = b.split(' ').filter(Boolean);
    const [corto, largo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (corto.length < 2 || corto.length === largo.length) return false;
    for (let i = 0; i + corto.length <= largo.length; i++) {
        if (largo.slice(i, i + corto.length).join(' ') === corto.join(' ')) return true;
    }
    return false;
}

export interface AtletaDuplicado {
    tabla: 'children' | 'unregistered_athletes';
    id: string;
    full_name: string;
    doc_number: string | null;
    date_of_birth: string | null;
    activo: boolean;
    coincide_por: 'documento' | 'nombre' | 'nombre_parecido';
}

/** Texto para el staff. Nombra CON QUIÉN coincide: sin eso no puede decidir. */
export function describirAtletaDuplicado(dup: AtletaDuplicado): string {
    const donde = dup.tabla === 'children'
        ? 'ya está registrado en la escuela'
        : 'ya existe como ficha precargada de la escuela';
    const como = dup.coincide_por === 'documento'
        ? `el documento ${dup.doc_number}`
        : dup.coincide_por === 'nombre'
            ? 'el mismo nombre'
            : 'un nombre casi igual';
    const datos = [
        dup.date_of_birth ? `nacido ${dup.date_of_birth}` : 'sin fecha de nacimiento',
        dup.doc_number ? `documento ${dup.doc_number}` : 'sin documento',
        dup.activo ? null : 'ficha INACTIVA',
    ].filter(Boolean).join(', ');
    return `"${dup.full_name}" ${donde} y coincide por ${como} (${datos}). `
        + 'Si es la misma persona, edita ese registro en vez de crear otro: '
        + 'crearlo de nuevo genera dos atletas facturables y la familia recibe el cobro dos veces.';
}

/** Se lanza en vez de insertar en silencio. El caller decide si ofrece la salida. */
export class AtletaDuplicadoError extends Error {
    readonly duplicado: AtletaDuplicado;
    constructor(duplicado: AtletaDuplicado) {
        super(describirAtletaDuplicado(duplicado));
        this.name = 'AtletaDuplicadoError';
        this.duplicado = duplicado;
        // La cadena de prototipos se pierde al extender Error compilando a ES5.
        Object.setPrototypeOf(this, AtletaDuplicadoError.prototype);
    }
}

export function esAtletaDuplicado(error: unknown): error is AtletaDuplicadoError {
    return error instanceof AtletaDuplicadoError
        || (typeof error === 'object' && error !== null && (error as any).name === 'AtletaDuplicadoError');
}

/**
 * Busca en la escuela un atleta que probablemente sea la misma persona.
 * Devuelve el primer match, priorizando documento > nombre exacto > contenido.
 *
 * Trae el padrón y compara en memoria a propósito: quitar acentos exige
 * `unaccent` y PostgREST no lo expone. La escuela más grande tiene 544 atletas
 * (debajo del tope de filas de PostgREST), así que el costo es irrelevante
 * frente a un alta.
 *
 * Si la consulta falla (RLS, red) devuelve null en vez de bloquear el alta: el
 * trigger de la base queda como última red. Se registra en consola porque un
 * fallo silencioso acá es exactamente cómo se colaron los duplicados.
 */
export async function buscarAtletaExistente(
    schoolId: string,
    opts: { docNumber?: string | null; fullName?: string | null },
): Promise<AtletaDuplicado | null> {
    const doc = normalizarDocumento(opts.docNumber);
    const nombre = normalizarNombreAtleta(opts.fullName) || null;
    if (!doc && !nombre) return null;

    const [kids, fichas] = await Promise.all([
        supabase.from('children')
            .select('id, full_name, doc_number, date_of_birth, is_active')
            .eq('school_id', schoolId)
            .limit(TOPE_PADRON),
        supabase.from('unregistered_athletes')
            .select('id, full_name, doc_number, date_of_birth, is_active')
            .eq('school_id', schoolId)
            .limit(TOPE_PADRON),
    ]);

    if (kids.error) console.error('Dedup atleta — no se pudo leer children:', kids.error.message);
    if (fichas.error) console.error('Dedup atleta — no se pudo leer unregistered_athletes:', fichas.error.message);

    const padron: AtletaDuplicado[] = [
        ...((kids.data ?? []) as any[]).map(r => ({
            tabla: 'children' as const,
            id: r.id, full_name: r.full_name, doc_number: r.doc_number ?? null,
            date_of_birth: r.date_of_birth ?? null,
            activo: r.is_active !== false,
            coincide_por: 'nombre' as const,
        })),
        ...((fichas.data ?? []) as any[]).map(r => ({
            tabla: 'unregistered_athletes' as const,
            id: r.id, full_name: r.full_name, doc_number: r.doc_number ?? null,
            date_of_birth: r.date_of_birth ?? null,
            activo: r.is_active !== false,
            coincide_por: 'nombre' as const,
        })),
    ];

    // PostgREST corta el resultado en su tope de filas sin avisar, y un padrón
    // truncado deja la comparación ciega justo en la escuela más grande — que es
    // donde más duplicados hay. Hoy la mayor va en 556 atletas, así que no se
    // alcanza; si algún día se alcanza, que se vea.
    if ((kids.data?.length ?? 0) >= TOPE_PADRON || (fichas.data?.length ?? 0) >= TOPE_PADRON) {
        console.error(
            `Dedup atleta — el padrón de la escuela ${schoolId} llegó al tope de ${TOPE_PADRON} filas: `
            + 'la búsqueda de duplicados puede estar incompleta. Hay que paginarla.',
        );
    }

    if (doc) {
        const hit = padron.find(r => normalizarDocumento(r.doc_number) === doc);
        if (hit) return { ...hit, coincide_por: 'documento' };
    }

    if (nombre) {
        const exacto = padron.find(r => normalizarNombreAtleta(r.full_name) === nombre);
        if (exacto) return { ...exacto, coincide_por: 'nombre' };

        // «Parecido» = nombre contenido en el otro (con apellido de más) o con UNA errata de tipeo
        // (Rodriguez / Rodruguez, Dreamers 2026-11-14).
        const parecido = padron.find(r => nombreContenido(normalizarNombreAtleta(r.full_name), nombre)
            || nombresParecidos(r.full_name, opts.fullName));
        if (parecido) return { ...parecido, coincide_por: 'nombre_parecido' };
    }

    return null;
}

/**
 * Helper: Crea un deportista y su pago pendiente de forma atómica.
 * Reutilizable desde cualquier flujo (modal, CSV, invitación).
 *
 * @param params Objeto con la información del deportista y del padre.
 * @returns Un objeto con el ID del deportista creado y estados de éxito de las inserciones.
 * @throws {AtletaDuplicadoError} si ya hay un atleta con ese documento o nombre
 *         en la escuela y el caller no pasó `allowDuplicate`.
 * @throws Error si la creación del deportista falla.
 */
export async function createStudentWithPendingPayment(params: {
    fullName: string;
    dateOfBirth?: string;
    /** Documento del atleta. Se persiste para que el guardián de la base
     *  (`trg_bloquear_atleta_duplicado`) tenga con qué comparar en el próximo alta. */
    docNumber?: string;
    parentEmail?: string;
    parentPhone?: string;
    parentName?: string;
    schoolId: string;
    schoolName?: string;
    branchId?: string;
    teamId?: string;
    teamName?: string;
    monthlyFee?: number; // Optional now, will fetch if missing
    medicalInfo?: string;
    notes?: string;
    dorsal?: string;
    /** Confirmación explícita del staff: "ya vi el duplicado, son personas
     *  distintas". Mismo criterio que `allow_duplicate` del BFF: la salida para
     *  el homónimo real existe, pero es consciente, nunca silenciosa. */
    allowDuplicate?: boolean;
    /**
     * ¿Este alta emite el cobro? `false` para el caller que acto seguido inscribe
     * en un plan por `POST /api/v1/enrollments`: esa ruta emite la mensualidad del
     * plan (emitPlanCharge) y si acá también se emitía, el mismo atleta nacía con
     * DOS cobros del mismo valor en meses distintos — y ni siquiera chocaban con
     * el índice único porque caían en períodos diferentes.
     * Por defecto true: el alta a secas (solo equipo) sigue cobrando una vez.
     */
    emitirCobro?: boolean;
}) {
    const { schoolId, teamId } = params;
    let { monthlyFee } = params;

    if (!params.allowDuplicate) {
        const dup = await buscarAtletaExistente(schoolId, {
            docNumber: params.docNumber,
            fullName: params.fullName,
        });
        if (dup) throw new AtletaDuplicadoError(dup);
    }

    // 0. Fetch team price if not provided (from teams table)
    if (!monthlyFee && teamId) {
        const { data: team } = await supabase
            .from('teams')
            .select('price_monthly, name')
            .eq('id', teamId)
            .maybeSingle();

        if (team) {
            // Equipo sin precio configurado = sin cuota. Antes caía en $150.000
            // inventados y el atleta nacía debiendo un monto que nadie definió.
            monthlyFee = Number(team.price_monthly) || 0;
            if (!params.teamName) params.teamName = team.name;
        }
    }

    // 1. Create student record in children table
    const { data: child, error: childError } = await supabase
        .from('children')
        .insert({
            full_name: params.fullName,
            date_of_birth: params.dateOfBirth || null,
            doc_number: params.docNumber?.trim() || null,
            parent_email_temp: params.parentEmail || null,
            parent_phone_temp: params.parentPhone || null,
            medical_info: params.medicalInfo || null,
            dorsal: params.dorsal || null,
            school_id: params.schoolId,
            branch_id: params.branchId || null,
            team_id: params.teamId || null,
        })
        .select()
        .single();

    // For production: throw error if insert fails
    if (childError) {
        console.error('Child insert failed:', childError.message);
        // El guardián de la base bloquea con unique_violation y solo se puede
        // forzar con `SET LOCAL app.permitir_atleta_duplicado`, que desde el
        // cliente no existe: acá el "crear igual" no alcanza y hay que decirlo.
        if ((childError as any).code === '23505' && /ya existe/i.test(childError.message ?? '')) {
            throw new Error(
                `${childError.message} La base bloquea este alta (mismo documento, o mismo nombre y misma `
                + 'fecha de nacimiento). Edita la ficha existente, o corrige el dato que de verdad difiere.',
            );
        }
        throw new Error(childError.message || 'Error al crear el deportista');
    }

    const childId = child.id;

    // 2. Create pending payment for this student
    const hoy = new Date();
    const dueDate = new Date(hoy);
    dueDate.setMonth(dueDate.getMonth() + 1);
    // EL PERÍODO ES EL MES DE ENTRADA, no el del vencimiento. Sin
    // period_year/period_month el trigger `trg_payments_fill_period` los deriva del
    // `due_date` (que acá cae el mes siguiente) y el mes en que el atleta entró no
    // se facturaba nunca. Mismo criterio que `calcFirstPayment` (prorationUtils) en
    // el alta canónica del BFF.
    const periodYear = hoy.getFullYear();
    const periodMonth = hoy.getMonth() + 1;

    let paymentError: any = null;

    // Solo se genera cobro si hay cuota (constraint payments_amount_positive: amount > 0)
    // y si este alta es el que cobra (ver `emitirCobro`).
    if (params.emitirCobro !== false && monthlyFee && monthlyFee > 0) {
        const { error } = await supabase
            .from('payments')
            .insert({
                parent_id: null,
                child_id: childId,
                school_id: schoolId,
                branch_id: params.branchId || null,
                amount: monthlyFee,
                concept: `Mensualidad ${params.teamName || 'Equipo'} - ${params.fullName}`,
                due_date: dueDate.toISOString().split('T')[0],
                status: 'pending',
                // 'one_time'|'subscription' (payments_payment_type_check); 'monthly' rompía el INSERT
                payment_type: 'one_time',
                period_year: periodYear,
                period_month: periodMonth,
            });
        paymentError = error;

        if (paymentError) {
            console.error('Payment insert failed:', paymentError.message);
        }
    }

    // 3. Send Invitation and Record in DB if parent email provided
    if (params.parentEmail) {
        try {
            // Record invitation in DB via RPC
            // The RPC automatically uses auth.uid() for 'invited_by'
            const { data: inviteId, error: inviteError } = await supabase.rpc('invite_parent_to_school', {
                p_parent_email: params.parentEmail.toLowerCase().trim(),
                p_child_name: params.fullName,
                p_team_id: params.teamId || null,
                p_monthly_fee: params.monthlyFee
            });

            if (inviteError || !inviteId) {
                // Without a valid inviteId the registration link would be broken.
                // Log and skip the email rather than sending a useless link.
                console.error('Error recording invitation in DB — skipping email send:', inviteError?.message ?? 'No inviteId returned');
                return { childId, success: true, childInserted: true, paymentInserted: !paymentError };
            }

            const inviteLink = `${window.location.origin}/register?email=${encodeURIComponent(params.parentEmail)}&role=parent&invite=${inviteId}`;

            await emailClient.send({
                type: 'parent_invitation',
                to: params.parentEmail,
                data: {
                    schoolName: params.schoolName || 'Tu Escuela',
                    childName: params.fullName,
                    registrationUrl: inviteLink,
                },
            });
            console.log(`✉️ Invitación enviada y registrada para ${params.parentEmail}`);
        } catch (inviteErr) {
            const message = inviteErr instanceof Error ? inviteErr.message : String(inviteErr);
            console.warn('Invitation process error:', message);
        }
    }

    return {
        childId,
        success: true,
        childInserted: true,
        paymentInserted: !paymentError,
    };
}
