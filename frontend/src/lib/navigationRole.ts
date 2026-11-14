// ============================================================================
// Rol con el que el menú lateral decide qué mostrar.
//
// `school_members.role = 'admin'` es administrador DE UN CLUB (permisos solo
// dentro de esa escuela). `profiles.role = 'admin'` / 'super_admin' es
// administrador de la PLATAFORMA SportMaps. Son cosas distintas: antes, el menú
// leía la membresía y mostraba el menú de plataforma (Escuelas, Suscripciones,
// Usuarios, Logs) a cualquier admin de club (ROADMAP UX-8).
//
// Reglas:
//   1. Los roles de plataforma (y personal_trainer / facility_manager) del PERFIL siempre ganan.
//   2. Una membresía 'admin' se presenta como 'school_admin' (menú de club).
//   3. Cualquier otro rol de membresía se respeta tal cual.
//   4. Sin membresía, vale el rol del perfil.
// ============================================================================
export function roleForNavigation(
  profileRole: string | null | undefined,
  membershipRole: string | null | undefined,
): string | undefined {
  const esPlataforma = profileRole === 'admin' || profileRole === 'super_admin';
  // facility_manager (dueño de espacios, school_type 'venue'): su membresía es
  // 'owner' de la escuela-venue, que daría el menú de academia. El rol del
  // PERFIL manda para que vea el menú corto de canchas.
  if (esPlataforma || profileRole === 'personal_trainer' || profileRole === 'facility_manager') {
    return profileRole ?? undefined;
  }
  if (membershipRole === 'admin') return 'school_admin';
  return membershipRole || profileRole || undefined;
}
