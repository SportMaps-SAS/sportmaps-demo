// Roles que administran instalaciones y reservas de instalaciones.
// Fuente única: la usan routes/facilities.ts y routes/reservations-admin.routes.ts.
// (requireRole deja pasar siempre owner/admin/super_admin; se listan por claridad.)
export const FACILITY_ADMIN_ROLES = [
  'owner',
  'super_admin',
  'admin',
  'school_admin',
  'school',
  'facility_manager',
] as const;

export type FacilityAdminRole = (typeof FACILITY_ADMIN_ROLES)[number];

export function isFacilityStaffRole(role: string | undefined | null): boolean {
  return !!role && (FACILITY_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * Roles que pueden operar lotes de reservas (IA / importadores) y bloqueos internos: solo administración.
 * NO coach, NO viewer/reporter, NO parent/athlete. ('school' y 'school_admin' son los nombres reales del
 * dueño/administrador en school_members; 'super_admin' = admin de plataforma, que requireRole deja pasar.)
 */
export const BATCH_ADMIN_ROLES = ['owner', 'admin', 'school_admin', 'school', 'facility_manager'] as const;
