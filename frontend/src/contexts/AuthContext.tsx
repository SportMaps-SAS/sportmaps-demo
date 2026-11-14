import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { Database } from '@/integrations/supabase/types';
import { getUserFriendlyError } from '@/lib/error-translator';
import { clearPwaTenant } from '@/pwa/tenant';
import { clearBoardSettings } from '@/lib/school/tacticalBoardSettings';
import { fetchRoleContexts, readStoredContextKey, storeContextKey, clearStoredContexts, clearStoredContextKey, safeInternalPath, type RoleContext } from '@/lib/roleContexts';

interface UserProfile {
  id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  role: 'athlete' | 'parent' | 'coach' | 'school' | 'school_admin' | 'wellness_professional' | 'store_owner' | 'admin' | 'super_admin' | 'organizer' | 'reporter' | 'personal_trainer' | 'accountant';
  avatar_url: string | null;
  bio: string | null;
  date_of_birth: string | null;
  sportmaps_points: number;
  subscription_tier: 'free' | 'basic' | 'premium';
  invitation_code?: string;
  school_name?: string;
  onboarding_completed?: boolean;
  onboarding_started?: boolean;
  needs_role_selection?: boolean;
  preferences?: any;
  created_at: string;
  updated_at: string;
}

interface AuthContextType {
  user: User | null;
  /**
   * Perfil para PRESENTAR la app. En una persona multirol, `profile.role` es el
   * rol del contexto activo (ver lib/roleContexts.ts); el rol guardado en la
   * base está en `realRole`. Los permisos los decide la base, no este valor.
   */
  profile: UserProfile | null;
  /** profiles.role tal como está en la base. */
  realRole: UserProfile['role'] | null;
  /** Contextos de rol (vacío si la persona tiene un solo rol). */
  roleContexts: RoleContext[];
  /** Contexto activo (null si no es multirol o aún no eligió). */
  activeRoleContext: RoleContext | null;
  /** Multirol sin elección guardada: hay que mostrar el selector. */
  needsRoleChoice: boolean;
  /** Cambia de contexto y recarga la app en `redirectTo` (por defecto /dashboard). */
  switchRoleContext: (key: string, redirectTo?: string) => void;
  session: Session | null;
  loading: boolean;
  isPersonalTrainer: boolean;
  trainerSchoolId: string | null;
  trainerOnboardingStatus: string | null;
  signUp: (email: string, password: string, userData: Partial<UserProfile>) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: (redirectTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>, options?: { silent?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPersonalTrainer, setIsPersonalTrainer] = useState(false);
  const [trainerSchoolId, setTrainerSchoolId] = useState<string | null>(null);
  const [trainerOnboardingStatus, setTrainerOnboardingStatus] = useState<string | null>(null);
  const [roleContexts, setRoleContexts] = useState<RoleContext[]>([]);
  const [activeContextKey, setActiveContextKey] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Usuario cuyo perfil ya cargamos (o estamos cargando). Evita el trabajo
  // duplicado entre las DOS rutas que arrancan sesión: getSession() y
  // onAuthStateChange (que dispara INITIAL_SESSION de inmediato). Las dos hacían
  // fetchProfile + fetchTrainerContext para el mismo usuario = 4 round-trips
  // donde bastan 2. También corta el refetch en TOKEN_REFRESHED, que reemplazaba
  // el objeto `profile` cada ~50 min y en cada vuelta a la pestaña, disparando
  // en cascada todo lo que depende de su identidad.
  const profileLoadedForRef = useRef<string | null>(null);
  // true mientras alguna de las dos rutas está cargando perfil + contextos. La
  // otra ruta NO debe soltar `loading` antes: si lo hacía, la app pintaba con el
  // rol real y sin contextos, y un instante después saltaba a /elegir-rol o
  // cambiaba de módulo (y los efectos corrían con el rol equivocado).
  const profileLoadingRef = useRef(false);

  const fetchProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        console.error('Error fetching profile:', error);
        throw error;
      }

      if (!data) {
        console.warn('No profile found for user:', userId);
        return null;
      }

      return data as UserProfile;
    } catch (error) {
      console.error('Error fetching profile:', error);
      return null;
    }
  }, []);

  // Detect personal trainer workspace (runs whenever user changes)
  const fetchTrainerContext = useCallback(async (userId: string, profileRole?: string) => {
    // Optimistic: if profile already says personal_trainer, set state immediately
    // so guards don't block before the DB query resolves.
    if (profileRole === 'personal_trainer') {
      setIsPersonalTrainer(true);
      // trainerSchoolId resolved below from DB
    }

    try {
      // Resilient to users with multiple PT workspaces: pick the oldest.
      // .maybeSingle() would error if more than one row matches.
      const { data: rows } = await supabase
        .from('schools')
        .select('id, school_type, onboarding_status, onboarding_step')
        .eq('owner_id', userId)
        .eq('school_type', 'personal_trainer')
        .order('created_at', { ascending: true })
        .limit(1);

      const data = rows?.[0];

      if (data && data.school_type === 'personal_trainer') {
        setIsPersonalTrainer(true);
        setTrainerSchoolId(data.id);
        setTrainerOnboardingStatus(data.onboarding_status);
      } else if (profileRole === 'personal_trainer') {
        // School not found yet (provisioning in progress), but role confirms trainer.
        // Keep isPersonalTrainer=true — trainerSchoolId stays null until provisioned.
        setIsPersonalTrainer(true);
        setTrainerOnboardingStatus(null);
      } else {
        setIsPersonalTrainer(false);
        setTrainerSchoolId(null);
        setTrainerOnboardingStatus(null);
      }
    } catch {
      // On error, fall back to role-based detection
      if (profileRole === 'personal_trainer') {
        setIsPersonalTrainer(true);
      } else {
        setIsPersonalTrainer(false);
        setTrainerSchoolId(null);
        setTrainerOnboardingStatus(null);
      }
    }
  }, []);

  // Contextos de rol: se resuelven ANTES de soltar `loading`, para que la app
  // cargue de una vez con el módulo del rol elegido (sin pintar otro y saltar).
  const loadRoleContexts = useCallback(async (userId: string, profileRole?: string) => {
    const contexts = await fetchRoleContexts(userId, profileRole);
    setRoleContexts(contexts);
    const stored = readStoredContextKey(userId);
    const valid = !!stored && contexts.some((c) => c.key === stored);
    // Elección guardada que ya no corresponde a los datos (terminó la inscripción,
    // dejó de ser staff…): se borra, para que useSchoolContext no siga aplicando
    // un rol viejo en esa escuela.
    if (stored && !valid) clearStoredContextKey(userId);
    setActiveContextKey(valid ? stored : null);
  }, []);

  const createProfile = useCallback(async (userId: string, userData: Partial<UserProfile>) => {
    try {
      // Check if profile already exists
      const existingProfile = await fetchProfile(userId);
      if (existingProfile) {
        return existingProfile;
      }

      const { data, error } = await supabase
        .from('profiles')

        .insert({
          id: userId,
          full_name: userData.full_name || 'Usuario',
          email: userData.email || '',
          phone: userData.phone || null,
          role: (userData.role || 'athlete') as Database["public"]["Enums"]["user_role"],
          avatar_url: userData.avatar_url || null,
          bio: null,
          date_of_birth: userData.date_of_birth || null,
          sportmaps_points: 0,
          subscription_tier: 'free',
          // Si no se proporcionó rol explícito (p. ej. login OAuth donde el
          // trigger aún no creó el perfil), marcar para forzar selección de rol.
          needs_role_selection: !userData.role,
        })
        .select()
        .maybeSingle();

      if (error) throw error;
      // Si el INSERT chocó con el perfil que el trigger ya creó, `data` puede
      // venir null. Releemos para no dejar el perfil en null (limbo OAuth).
      if (!data) {
        return await fetchProfile(userId);
      }
      return data;
    } catch (error) {
      console.error('Error creating profile:', error);
      throw error;
    }
  }, [fetchProfile]);

  useEffect(() => {
    let mounted = true;

    // Get initial session from Supabase
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!mounted) return;

      setSession(session);
      setUser(session?.user || null);

      if (session?.user) {
        try {
          profileLoadedForRef.current = session.user.id;
          profileLoadingRef.current = true;
          const userProfile = await fetchProfile(session.user.id);
          if (mounted) {
            if (userProfile) {
              setProfile(userProfile);
            } else {
              const created = await createProfile(session.user.id, {
                full_name: session.user.user_metadata?.full_name || 'Usuario',
                email: session.user.email || '',
                // NO forzar 'athlete': si no hay rol (OAuth/Google), dejarlo
                // undefined para que createProfile marque needs_role_selection=true
                // y el usuario pase por /onboarding/role en vez de quedar atleta.
                role: session.user.user_metadata?.role,
              });
              setProfile(created as UserProfile);
            }
            // Detect trainer workspace — pass role for immediate detection
            const resolvedRole = (userProfile ?? null)?.role ||
              session.user.user_metadata?.role;
            await fetchTrainerContext(session.user.id, resolvedRole);
            await loadRoleContexts(session.user.id, resolvedRole);
          }
        } catch (error) {
          // Si falló, liberar el guard para que la otra ruta sí lo reintente.
          profileLoadedForRef.current = null;
          console.error('Failed to load/create profile:', error);
        } finally {
          profileLoadingRef.current = false;
        }
      }

      if (mounted) {
        setLoading(false);
      }
    }).catch((error) => {
      console.error('Session error:', error);
      if (mounted) setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!mounted) return;

        // ★ Interceptar el evento PASSWORD_RECOVERY para redirigir al formulario de nueva contraseña
        if (event === 'PASSWORD_RECOVERY') {
          // Supabase inicia sesión automáticamente con el token del email,
          // lo que haría que el ProtectedRoute deje pasar al usuario al Dashboard.
          // En vez de eso, lo redirigimos al formulario de cambio de contraseña.
          //
          // Si YA estamos en /reset-password no navegamos: el enlace nuevo
          // (`?token_hash=…`) canjea el token con verifyOtp() desde esa misma
          // página, y una navegación dura aquí borraría el query string y
          // recargaría el componente a mitad del canje.
          if (window.location.pathname !== '/reset-password') {
            window.location.href = '/reset-password';
          }
          return;
        }

        // Synchronous updates only
        setSession(session);
        setUser(session?.user || null);

        // Defer Supabase fetches to avoid deadlocks
        if (session?.user) {
          // Ya cargamos (o estamos cargando) el perfil de ESTE usuario: no repetir.
          // Un usuario distinto sí debe re-resolver todo.
          if (profileLoadedForRef.current === session.user.id) {
            // Si la otra ruta sigue cargando, ella suelta `loading` al terminar.
            if (!profileLoadingRef.current) setLoading(false);
            return;
          }
          profileLoadedForRef.current = session.user.id;
          profileLoadingRef.current = true;

          setTimeout(async () => {
            try {
              const userProfile = await fetchProfile(session.user!.id);
              if (mounted) {
                if (userProfile) {
                  setProfile(userProfile);
                } else {
                  const created = await createProfile(session.user!.id, {
                    full_name: session.user!.user_metadata?.full_name || 'Usuario',
                    email: session.user!.email || '', // FIX: Pass email
                    role: session.user!.user_metadata?.role || 'athlete',
                  });
                  setProfile(created as UserProfile);
                }
                // Detect trainer workspace — pass role for immediate detection
                const resolvedRole2 = (userProfile ?? null)?.role ||
                  session.user!.user_metadata?.role;
                await fetchTrainerContext(session.user!.id, resolvedRole2);
                await loadRoleContexts(session.user!.id, resolvedRole2);
              }
            } catch (error) {
              profileLoadedForRef.current = null;
              console.error('Deferred profile load/create failed:', error);
            } finally {
              profileLoadingRef.current = false;
              if (mounted) setLoading(false);
            }
          }, 0);
        } else {
          profileLoadedForRef.current = null;
          setProfile(null);
          setIsPersonalTrainer(false);
          setTrainerSchoolId(null);
          setTrainerOnboardingStatus(null);
          setRoleContexts([]);
          setActiveContextKey(null);
          setLoading(false);
        }
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [fetchProfile, createProfile, fetchTrainerContext, loadRoleContexts]);

  const signUp = async (email: string, password: string, userData: Partial<UserProfile> & { invitation_code?: string, school_name?: string }) => {
    try {
      const redirectUrl = `${window.location.origin}/`;

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            full_name: userData.full_name,
            phone: userData.phone,
            date_of_birth: userData.date_of_birth,
            role: userData.role,
            invitation_code: userData.invitation_code,
            school_name: userData.school_name,
          }
        }
      });

      if (error) throw error;

      if (data.user) {
        // Profile creation is handled by DB Triggers for security
        toast({
          title: "¡Registro exitoso!",
          description: "Bienvenido a SportMaps. Tu cuenta ha sido creada.",
        });

        // La bienvenida la manda el BFF (jobs/bienvenida-escuelas.job.ts) al ver
        // la escuela creada: así sale también con Google y para entrenadores.
      }
    } catch (error: unknown) {
      console.error('Error signing up:', error);
      toast({
        title: "Error en el registro",
        description: getUserFriendlyError(error),
        variant: "destructive",
      });
      throw error;
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      toast({
        title: "Inicio de sesión exitoso",
        description: "Bienvenido a SportMaps",
      });
    } catch (error: unknown) {
      console.error('Error signing in:', error);
      toast({
        title: "Error en el inicio de sesión",
        description: getUserFriendlyError(error),
        variant: "destructive",
      });
      throw error;
    }
  };

  const signInWithGoogle = async (redirectTo: string = '/dashboard') => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}${redirectTo}`,
          queryParams: {
            // Forzar selector de cuenta para evitar reusar sesión Google anterior.
            prompt: 'select_account',
          },
        },
      });

      if (error) throw error;
      // En éxito el navegador navega a Google; el resto del flujo lo maneja
      // onAuthStateChange al volver a la app.
    } catch (error: unknown) {
      console.error('Error with Google sign-in:', error);
      throw error;
    }
  };

  const signOut = async () => {
    const cleanupClientState = () => {
      // Clear demo session storage
      sessionStorage.removeItem('demo_mode');
      sessionStorage.removeItem('demo_role');
      sessionStorage.removeItem('demo_tour_pending');

      // Force-clear Supabase auth tokens to prevent zombie sessions
      const supabaseKeys = Object.keys(localStorage).filter(k => k.startsWith('sb-'));
      supabaseKeys.forEach(key => localStorage.removeItem(key));

      // Clear all app-specific localStorage to prevent data leaking between sessions
      localStorage.removeItem('sportmaps_cart');
      localStorage.removeItem('sportmaps_active_school_id');
      localStorage.removeItem('sportmaps_pending_enrollment');
      localStorage.removeItem('sportmaps_favoritos');
      localStorage.removeItem('sportmaps_welcome_dismissed');
      localStorage.removeItem('pending_invite_id');
      // Código de escuela guardado entre /unirse y el registro (lib/schoolJoinCode).
      localStorage.removeItem('sportmaps_pending_join_code');
      // Rol elegido (multirol): el próximo inicio de sesión vuelve a preguntar.
      clearStoredContexts();
      // Preferencias de la pizarra táctica: la foto de jugadores menores no
      // debe quedar prendida para el siguiente que use este dispositivo.
      localStorage.removeItem('tactical_board_pin_photos');
      localStorage.removeItem('tactical_board_pin_style');
      // Ajustes de la pizarra (M6g): claves por usuario con prefijo común;
      // se borran TODAS por prefijo, no una lista que se desactualiza.
      clearBoardSettings();

      // Marca de la escuela (PWA). Critico: localStorage es del NAVEGADOR, no
      // del usuario. Sin esto el logo, el nombre y el manifest de una escuela
      // sobreviven al cierre de sesion y se los lleva puestos el siguiente que
      // entre en ese dispositivo, aunque no pertenezca a esa escuela.
      clearPwaTenant();

      // Cache del service worker con respuestas de Supabase REST.
      //
      // El SW las guarda con la URL como clave, SIN el token: dos usuarios
      // distintos que piden la misma URL comparten entrada. En un dispositivo
      // compartido —el celular de una familia, la tablet de la recepcion— si la
      // red falla un instante despues del cambio de cuenta, el fallback offline
      // le entrega al segundo usuario los datos del primero.
      //
      // Es la misma clase de fuga que la de la marca: el cache es del
      // DISPOSITIVO, no de la persona. Aca ademas son datos personales.
      // Fire-and-forget: si falla no se bloquea el cierre de sesion.
      if ('caches' in window) {
        void caches.delete('supabase-api').catch(() => { /* no-op */ });
      }

      // Reset BFF module-level school header so the next user doesn't inherit it.
      bffClient.setSchoolId(null);

      // Clear React Query cache so the next user doesn't see stale data
      queryClient.clear();
    };

    try {
      cleanupClientState();

      // Regular Supabase signout
      const { data: { session: currentSession } } = await supabase.auth.getSession();

      if (currentSession) {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      }

      // Clear local state
      setUser(null);
      setSession(null);
      setProfile(null);

      // Hard-reload to /login. Without this, providers stay mounted and
      // module-level state (query cache, context refs) can leak across users.
      window.location.replace('/login');
    } catch (error: unknown) {
      const err = error as Error;
      console.error('Error signing out:', error);
      // Still clear local state even if signOut fails
      setUser(null);
      setSession(null);
      setProfile(null);
      cleanupClientState();

      // Only show error if it's not a session missing error
      if (!err.message?.includes('session')) {
        toast({
          title: "Error",
          description: getUserFriendlyError(err),
          variant: "destructive",
        });
      }

      window.location.replace('/login');
    }
  };

  const updateProfile = async (updates: Partial<UserProfile>, options?: { silent?: boolean }) => {
    if (!user) throw new Error('No user logged in');
    const silent = options?.silent || false;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() } as Database["public"]["Tables"]["profiles"]["Update"])
        .eq('id', user.id);

      if (error) throw error;

      const updatedProfile = await fetchProfile(user.id);
      if (updatedProfile) setProfile(updatedProfile);

      if (!silent) {
        toast({
          title: "Perfil actualizado",
          description: "Tus datos han sido actualizados exitosamente",
        });
      }
    } catch (error: unknown) {
      console.error('Error updating profile:', error);
      toast({
        title: "Error",
        description: getUserFriendlyError(error),
        variant: "destructive",
      });
      throw error;
    }
  };

  const activeRoleContext = useMemo(
    () => roleContexts.find((c) => c.key === activeContextKey) ?? null,
    [roleContexts, activeContextKey],
  );

  // Perfil de presentación: solo cambia `role` en una persona multirol con un
  // contexto elegido. El objeto es estable mientras no cambien sus entradas.
  const viewProfile = useMemo<UserProfile | null>(() => {
    if (!profile || !activeRoleContext) return profile;
    return { ...profile, role: activeRoleContext.viewRole };
  }, [profile, activeRoleContext]);

  const switchRoleContext = useCallback((key: string, redirectTo: string = '/dashboard') => {
    if (!user || !roleContexts.some((c) => c.key === key)) return;
    const destino = safeInternalPath(redirectTo, '/dashboard');
    const guardado = storeContextKey(user.id, key);
    // La escuela del contexto pasa a ser la activa (useSchoolContext la lee de acá).
    const ctx = roleContexts.find((c) => c.key === key);
    if (ctx?.schoolId) {
      try { localStorage.setItem('sportmaps_active_school_id', ctx.schoolId); } catch { /* sin storage */ }
    }
    queryClient.clear();
    if (!guardado) {
      // Sin storage (modo privado/bloqueado) una recarga perdería la elección y
      // volvería a mostrar el selector para siempre. Se aplica en memoria y se
      // navega sin recargar (BrowserRouter escucha popstate).
      setActiveContextKey(key);
      window.history.pushState(null, '', destino);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    // Recarga completa: todos los providers y cachés se resuelven de cero con
    // el rol nuevo (el mismo criterio que el cierre de sesión).
    window.location.assign(destino);
  }, [user, roleContexts, queryClient]);

  const needsRoleChoice = roleContexts.length > 0 && !activeRoleContext;

  const value = useMemo(() => ({
    user,
    profile: viewProfile,
    realRole: profile?.role ?? null,
    roleContexts,
    activeRoleContext,
    needsRoleChoice,
    switchRoleContext,
    session,
    loading,
    isPersonalTrainer,
    trainerSchoolId,
    trainerOnboardingStatus,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    updateProfile,
  }), [user, viewProfile, profile?.role, roleContexts, activeRoleContext, needsRoleChoice, switchRoleContext, session, loading, isPersonalTrainer, trainerSchoolId, trainerOnboardingStatus]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Como useAuth, pero devuelve null fuera del AuthProvider en vez de
 *  reventar: para piezas que también se montan sueltas (p. ej. la pizarra en
 *  pruebas) y que sin sesión simplemente no persisten nada. */
export function useOptionalAuth() {
  return useContext(AuthContext) ?? null;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}