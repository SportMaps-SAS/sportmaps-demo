import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { getCachedUser, getCachedMembership, type CachedUser } from '../utils/authCache';
import { esAdminDePlataforma } from './requirePlatformAdmin';

/**
 * Valida el Bearer token contra Supabase, con cache de TTL corto.
 * Ver utils/authCache.ts para el porque y las garantias de seguridad.
 */
async function resolveUser(token: string): Promise<CachedUser | null> {
    return getCachedUser(token, async () => {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return null;
        return {
            id: user.id,
            email: user.email!,
            user_metadata: user.user_metadata,
        };
    });
}

// ── Augmentar el tipo global de Express.Request ───────────────────────────────
declare global {
    namespace Express {
        interface Request {
            user: { 
                id: string; 
                email: string;
                user_metadata?: {
                    full_name?: string;
                    [key: string]: any;
                };
            };
            schoolId: string;
            branchId: string | null;
            role: 'owner' | 'admin' | 'super_admin' | 'auditor' | 'reporter'
            | 'school_admin' | 'school' | 'coach' | 'parent' | 'athlete' | 'staff' | 'organizer'
            | 'store_owner' | 'external_vendor' | 'wellness_professional' | 'personal_trainer'
            | 'facility_manager'
            // Contabilidad v2 F0: contador de la escuela (solo lectura financiera).
            // No entra a /reports en F0 (decisión U2): no está en ningún requireRole.
            | 'accountant';
            log: import('pino').Logger;
            id: string;
        }
    }
}

export type AuthenticatedRequest = Request;

// Roles que siempre pasan requireRole sin necesidad de estar listados
const PRIVILEGED_ROLES = ['owner', 'super_admin', 'admin'] as const;

// ─────────────────────────────────────────────────────────────────────────────
export const requireBasicAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de autorización requerido.' });
        }

        const token = authHeader.split(' ')[1];
        // Solo necesitamos pasar el token al request para que los controladores hagan pass-through a BD
        (req as any).userToken = token;

        next();
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
export const requireAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        // 1. Validar Bearer token
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de autorización requerido.' });
        }

        const token = authHeader.split(' ')[1];
        const user = await resolveUser(token);

        if (!user) {
            return res.status(401).json({ error: 'Token inválido o expirado.' });
        }

        // 2. Escape hatch para roles de plataforma (super_admin / admin global).
        //    Esos usuarios no necesitan estar en school_members — su rol vive
        //    en profiles. Sin esto, cualquier endpoint que use requireAuth
        //    rechaza al super_admin con 403 "No tienes permisos para acceder
        //    a esta escuela", incluso si el router montado siguiente no
        //    necesita contexto de escuela (ej. marketplaceAdminRouter que va
        //    montado en /api/v1/admin junto a adminPayoutsRouter).
        const targetSchoolId = req.headers['x-school-id'] as string | undefined;

        // Rol + escuela van juntos en una sola entrada de cache: son las dos
        // consultas que corrian en CADA request. Solo se resuelven en miss.
        const membership = await getCachedMembership(user.id, targetSchoolId, token, async () => {
            // El staff de plataforma se pregunta a `platform_admins`, NO a
            // `profiles.role`.
            //
            // Esto era la mitad no cerrada de una escalada real. `authenticated`
            // tiene GRANT de UPDATE sobre las columnas `role` y `role_id` de
            // `profiles`, y su única policy de UPDATE es `USING (auth.uid() = id)`,
            // que ata la FILA al usuario pero no dice nada de las COLUMNAS (en RLS
            // no existe granularidad por columna). O sea que cualquier usuario
            // podía escribirse `role='super_admin'` desde el navegador y, con este
            // escape hatch, recibir membresía de CUALQUIER escuela que nombrara en
            // el header x-school-id — sin figurar en school_members.
            //
            // Las policies de RLS ya se habían migrado a is_super_admin() en
            // agosto (20260821200453, 20260821201424, 20260824165639), pero el BFF
            // entra con service_role y salta RLS: este chequeo es su propio gate y
            // se quedó leyendo la columna vieja. Cerrar solo un plano no cierra
            // nada.
            //
            // `platform_admins` es la misma fuente que usa is_super_admin(), y el
            // cliente no la puede escribir. Ojo (documentado en el repo): si esa
            // tabla queda vacía, NADIE es staff de plataforma.
            //
            // No lleva columna de nivel: figurar ahí ES ser super admin, igual que
            // asume is_super_admin(). Por eso se devuelve 'super_admin' fijo y no
            // se conserva la distinción con 'admin' que hacía el chequeo viejo —
            // esa distinción venía de profiles.role, que es justo el dato que no
            // se puede creer. requireSuperAdminStrict (admin-support.routes.ts)
            // sigue funcionando: la única fila activa es la del super admin real.
            const { data: platformAdmin } = await supabase
                .from('platform_admins')
                .select('profile_id')
                .eq('profile_id', user.id)
                .eq('is_active', true)
                .maybeSingle();

            if (platformAdmin) {
                return {
                    schoolId: targetSchoolId || '',
                    branchId: null,
                    role: 'super_admin',
                };
            }

            // 3. Resto de usuarios: validar contra school_members
            let q = supabase
                .from('school_members')
                .select('school_id, role, branch_id')
                .eq('profile_id', user.id)
                .eq('status', 'active');

            // Si el frontend envió x-school-id, filtrar por esa escuela exacta.
            // De lo contrario, tomar el primer registro activo del usuario.
            if (targetSchoolId) {
                q = q.eq('school_id', targetSchoolId);
            }

            const { data: members, error: memberErr } = await q
                .order('joined_at', { ascending: false })
                .limit(1);

            // Error de BD: se propaga para que NO se cachee un fallo transitorio
            // como si fuera "sin permisos".
            if (memberErr) {
                req.log?.error({ err: memberErr }, 'Error consultando school_members');
                throw new Error('Error interno verificando permisos.');
            }

            if (!members || members.length === 0) return null;

            const member = members[0] as any;
            return {
                schoolId: member.school_id,
                branchId: member.branch_id ?? null,
                role: member.role,
            };
        });

        if (!membership) {
            return res.status(403).json({
                error: 'No tienes permisos para acceder a esta escuela.',
                detail: `profile_id=${user.id} no encontrado en school_members con status=active`
                    + (targetSchoolId ? ` y school_id=${targetSchoolId}` : ''),
            });
        }

        req.user = {
            id: user.id,
            email: user.email!,
            user_metadata: user.user_metadata,
        };
        req.schoolId = membership.schoolId;
        req.branchId = membership.branchId;
        req.role = membership.role as Request['role'];

        next();
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
export const requireRole = (...roles: Request['role'][]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        // Los roles privilegiados siempre pasan aunque no estén en la lista
        if ((PRIVILEGED_ROLES as readonly string[]).includes(req.role)) {
            return next();
        }

        if (!roles.includes(req.role)) {
            return res.status(403).json({
                error: `Acceso denegado. Roles permitidos: ${roles.join(', ')}.`,
                receivedRole: req.role,
            });
        }

        next();
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// requireVendorProfile — Autoriza por capability de vendor_profile,
// NO por role. Reemplaza a requireRole para rutas de venta.
//
// Uso:
//   router.use(requireMarketplaceAuth);
//   router.use(requireVendorProfile('can_sell_products'));
//
// Reglas:
//  - admin/super_admin/owner: pasan automáticamente.
//  - Resto: requieren vendor_profile.is_active = true Y la capability solicitada = true.
//  - El user_id se toma de req.user.id (debe haber pasado por un auth middleware).
//  - La verificación usa la función SQL has_vendor_capability(uuid, text)
//    creada en la migración 20260511000002.
// ─────────────────────────────────────────────────────────────────────────────
type VendorCapability = 'can_sell_products' | 'can_sell_services';

export const requireVendorProfile = (capability: VendorCapability) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Privilegios siempre pasan
        if ((PRIVILEGED_ROLES as readonly string[]).includes(req.role)) {
            return next();
        }

        if (!req.user?.id) {
            return res.status(401).json({ error: 'No autenticado.' });
        }

        try {
            const { data, error } = await supabase.rpc('has_vendor_capability', {
                p_user_id:    req.user.id,
                p_capability: capability,
            });

            if (error) {
                req.log?.error({ err: error, capability }, 'Error verificando capability de vendor');
                return res.status(500).json({ error: 'Error interno verificando permisos de vendedor.' });
            }

            if (data !== true) {
                return res.status(403).json({
                    error: 'Tu cuenta no tiene activada esta capacidad de venta.',
                    capability,
                    hint: 'Activa Mi Tienda desde tu dashboard para empezar a vender.',
                });
            }

            next();
        } catch (err) {
            next(err);
        }
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// requireOwnership — Previene IDOR (Insecure Direct Object Reference)
// Verifica que el recurso solicitado pertenece a la escuela del usuario.
//
// Uso: requireOwnership('children', 'id')
//   → Antes de ejecutar el handler, consulta `children` donde `id = req.params.id`
//     y verifica que `school_id = req.schoolId`.
//
// Para tablas sin school_id directo, usar el parámetro ownerField:
//   requireOwnership('event_organizers', 'id', 'profile_id')
//   → Verifica que `profile_id = req.user.id`
// ─────────────────────────────────────────────────────────────────────────────
export const requireOwnership = (
    table: string,
    paramName: string = 'id',
    ownerField: 'school_id' | 'profile_id' | 'user_id' | 'parent_id' | 'creator_id' = 'school_id',
) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const resourceId = req.params[paramName];
            if (!resourceId) {
                return res.status(400).json({ error: `Parámetro "${paramName}" requerido.` });
            }

            // Determinar el valor esperado según el campo de propiedad
            let expectedValue: string;
            if (ownerField === 'school_id') {
                expectedValue = req.schoolId;
            } else if (ownerField === 'profile_id' || ownerField === 'user_id' || ownerField === 'creator_id') {
                expectedValue = req.user.id;
            } else if (ownerField === 'parent_id') {
                expectedValue = req.user.id;
            } else {
                expectedValue = req.user.id;
            }

            const { data, error } = await supabase
                .from(table)
                .select('id')
                .eq('id', resourceId)
                .eq(ownerField, expectedValue)
                .maybeSingle();

            if (error) {
                req.log?.error({ err: error, table, resourceId }, 'Error verificando propiedad del recurso');
                return res.status(500).json({ error: 'Error verificando propiedad del recurso.' });
            }

            if (!data) {
                return res.status(404).json({
                    error: 'Recurso no encontrado o no tienes acceso.',
                });
            }

            next();
        } catch (err) {
            next(err);
        }
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// auditLog — Registra acciones sensibles en security_audit_log
// Uso dentro de un handler:
//   await auditLog(req, 'payment_create', 'payments', paymentId, null, { amount });
// ─────────────────────────────────────────────────────────────────────────────
export const auditLog = async (
    req: Request,
    action: string,
    targetTable: string,
    targetId: string,
    oldValue?: Record<string, unknown> | null,
    newValue?: Record<string, unknown> | null,
) => {
    try {
        await supabase.from('security_audit_log').insert({
            user_id: req.user?.id || null,
            action,
            target_table: targetTable,
            target_id: targetId,
            old_value: oldValue || null,
            new_value: newValue || null,
            ip_address: req.ip || req.headers['x-forwarded-for'] || null,
            user_agent: req.headers['user-agent'] || null,
            metadata: {
                school_id: req.schoolId || null,
                role: req.role || null,
                request_id: req.id || null,
            },
        });
    } catch (err) {
        // Audit failure must never break the request
        req.log?.warn({ err, action, targetTable, targetId }, 'Audit log write failed');
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// requireMarketplaceAuth — Auth ligero para vendedores independientes
// Valida Bearer token y lee role de profiles, SIN requerir school_members.
// Usar para rutas de vendor que no dependen de contexto de escuela.
// ─────────────────────────────────────────────────────────────────────────────
export const requireMarketplaceAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de autorización requerido.' });
        }

        const token = authHeader.split(' ')[1];
        const user = await resolveUser(token);

        if (!user) {
            return res.status(401).json({ error: 'Token inválido o expirado.' });
        }

        // Leer role directamente de profiles (no de school_members)
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .maybeSingle();

        if (profileErr) {
            req.log?.error({ err: profileErr }, 'Error consultando profile para marketplace auth');
            return res.status(500).json({ error: 'Error interno verificando permisos.' });
        }

        req.user = { 
            id: user.id, 
            email: user.email!, 
            user_metadata: user.user_metadata 
        };
        // profiles.role lo fija el signup desde raw_user_meta_data: no es fuente
        // de privilegio. 'admin'/'super_admin' pasan requireVendorProfile y el gate
        // de vendor-products por PRIVILEGED_ROLES, así que solo se respetan si la
        // cuenta figura en platform_admins (misma fuente que is_super_admin()).
        let role = (profile?.role as Request['role']) || 'athlete';
        if (role === 'admin' || role === 'super_admin') {
            role = (await esAdminDePlataforma(user.id)) ? 'super_admin' : 'athlete';
        }
        req.role = role;
        // schoolId y branchId no aplican para vendor routes
        req.schoolId = '';
        req.branchId = null;

        next();
    } catch (err) {
        next(err);
    }
};

// requireTrainerAuth — Middleware exclusivo para entrenadores personales.
// No depende de school_members — resuelve el schoolId directo desde schools.
// ─────────────────────────────────────────────────────────────────────────────
export const requireTrainerAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de autorización requerido.' });
        }

        const token = authHeader.split(' ')[1];
        const user = await resolveUser(token);

        if (!user) {
            return res.status(401).json({ error: 'Token inválido o expirado.' });
        }

        // Resolver el workspace del entrenador personal
        const { data: school, error: schoolErr } = await supabase
            .from('schools')
            .select('id, school_type, onboarding_status')
            .eq('owner_id', user.id)
            .eq('school_type', 'personal_trainer')
            .maybeSingle();

        if (schoolErr) {
            req.log?.error({ err: schoolErr }, 'Error consultando trainer school');
            return res.status(500).json({ error: 'Error interno verificando permisos.' });
        }

        // Si no tiene workspace aún, verificar si al menos tiene rol personal_trainer
        // para permitir que el onboarding/provisioning pueda correr
        if (!school) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', user.id)
                .maybeSingle();

            if (profile?.role !== 'personal_trainer') {
                return res.status(403).json({
                    error: 'Acceso denegado. Se requiere rol de entrenador personal.',
                });
            }

            req.user     = { 
                id: user.id, 
                email: user.email!, 
                user_metadata: user.user_metadata 
            };
            req.schoolId = '';
            req.branchId = null;
            req.role     = 'owner' as Request['role'];
            return next();
        }

        req.user     = { 
            id: user.id, 
            email: user.email!, 
            user_metadata: user.user_metadata 
        };
        req.schoolId = school.id;
        req.branchId = null;
        req.role     = 'owner' as Request['role'];

        next();
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// optionalAuth — Auth opcional para rutas publicas del marketplace
// Si hay token valido, setea req.user. Si no, req.user = null y continua.
// Permite browsing anonimo con personalizacion para usuarios logueados.
// ─────────────────────────────────────────────────────────────────────────────
export const optionalAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            (req as any).user = null;
            return next();
        }

        const token = authHeader.split(' ')[1];
        const user = await resolveUser(token);

        if (!user) {
            // El caller envio un Authorization header pero el token es invalido.
            // Antes esto pasaba silencioso y el atacante podia probar tokens sin
            // dejar rastro. Logueamos para que aparezca en metricas de seguridad
            // y se pueda correlacionar con ataques.
            req.log?.warn(
                {
                    err: 'token rechazado por Supabase',
                    ua: req.headers['user-agent'],
                    ip: req.ip,
                },
                'optionalAuth: JWT presente pero invalido — continuando como anon',
            );
            (req as any).user = null;
            return next();
        }

        req.user = {
            id: user.id,
            email: user.email!,
            user_metadata: user.user_metadata,
        };

        next();
    } catch (err) {
        // Igual que el caso de JWT invalido pero por error inesperado del SDK.
        req.log?.warn(
            { err: (err as any)?.message ?? err, ua: req.headers['user-agent'], ip: req.ip },
            'optionalAuth: error inesperado validando JWT — continuando como anon',
        );
        (req as any).user = null;
        next();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// requireAthleteAuth — Middleware para atletas y padres (self-service).
// No requiere school_members si solo accede a su propia información de perfil.
// ─────────────────────────────────────────────────────────────────────────────
export const requireAthleteAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de autorización requerido.' });
        }

        const token = authHeader.split(' ')[1];
        const user = await resolveUser(token);

        if (!user) {
            return res.status(401).json({ error: 'Token inválido o expirado.' });
        }

        // Leer perfil para confirmar rol
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('id, role')
            .eq('id', user.id)
            .maybeSingle();

        if (profileErr) {
            req.log?.error({ err: profileErr }, 'Error consultando profile para athlete auth');
            return res.status(500).json({ error: 'Error interno verificando permisos.' });
        }

        const role = profile?.role as string;
        if (!['athlete', 'parent', 'owner', 'personal_trainer'].includes(role)) {
            return res.status(403).json({
                error: 'Acceso denegado. Se requiere rol de atleta o padre.',
            });
        }

        req.user     = { 
            id: user.id, 
            email: user.email!, 
            user_metadata: user.user_metadata 
        };
        req.role     = role as Request['role'];
        req.schoolId = ''; // No aplica contexto de escuela obligatoria
        req.branchId = null;

        next();
    } catch (err) {
        next(err);
    }
};
