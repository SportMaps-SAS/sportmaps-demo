/**
 * «Más» del entrenador — lógica PURA (lienzo «CoaMas» y tabla de «CoaMapa»).
 *
 * Regla: ninguna entrada que el coach tiene hoy se pierde. La fuente es el menú
 * real (`getNavigationByRole('coach', …)` de config/navigation.ts, que ya poda por
 * moduleKey, adicionales y tienda) + la barra inferior actual (MobileBottomNav,
 * caso coach). Lo que va en la barra V2 (Hoy · Equipos · Sesiones · Asistencia)
 * no se repite aquí; todo lo demás cae en un grupo de «Más». Una ruta nueva del
 * menú que este archivo no conozca no se pierde: va a «Otros» con su título.
 */

export interface EntradaNav { title: string; href?: string; submenu?: EntradaNav[] }

export type GrupoMas = 'Mi trabajo' | 'Entrenamiento' | 'Mis servicios' | 'Comunicación' | 'Ayuda' | 'Cuenta' | 'Otros';

export interface FilaMas {
  label: string;
  nota?: string;
  to?: string;
  href?: string;
  accion?: 'mapi' | 'salir';
  peligro?: boolean;
}

/**
 * Rutas del coach que viven dentro de las pestañas de la barra V2
 * (CoaMapa: «Cada entrada del menú de hoy y dónde queda»).
 */
export const RUTAS_EN_BARRA_COACH: Record<string, 'Hoy' | 'Equipos' | 'Sesiones' | 'Asistencia'> = {
  '/dashboard': 'Hoy',
  '/teams': 'Equipos',
  '/students': 'Equipos',
  '/results': 'Equipos',
  '/training-plans': 'Sesiones',
  '/coach-attendance': 'Asistencia',
  '/coach-attendance/scan': 'Asistencia',
  '/school/attendance-sheets': 'Asistencia',
};

/** La pestaña «Más» misma (la barra V2 la trae en el menú). */
export const RUTA_MAS = '/mas';

/**
 * Menú lateral del coach ANTES de la V2 (config/navigation.ts, rama
 * `ENTRENADOR_V2 = false`). Con la V2 el menú del coach queda en las cinco
 * pestañas, así que «Más» necesita la lista completa para no perder nada.
 * coachMasModel.test.ts compara esta lista contra la rama clásica real: si
 * alguien agrega una entrada allá, la prueba avisa.
 */
export const MENU_COACH_CLASICO: { title: string; href: string; moduleKey?: string }[] = [
  { title: 'Dashboard', href: '/dashboard' },
  { title: 'Mis Equipos', href: '/teams' },
  { title: 'Sesiones de Entrenamiento', href: '/training-plans' },
  { title: 'Mis Planes', href: '/coach-plans', moduleKey: 'gestion_deportiva_disponibilidad_coach' },
  { title: 'Mi Dotación', href: '/coach/dotacion' },
  { title: 'Mis Deportistas', href: '/students' },
  { title: 'Disponibilidad médica', href: '/disponibilidad-medica' },
  { title: 'Calendario', href: '/calendar' },
  { title: 'Gestión de Rutinas', href: '/school/routines' },
  { title: 'Supervisión', href: '/coach-attendance' },
  { title: 'Encuestas', href: '/dashboard/polls' },
  { title: 'Resultados', href: '/results' },
  { title: 'Reportes', href: '/coach-reports' },
  { title: 'Planillas por revisar', href: '/school/attendance-sheets' },
  { title: 'Informe Mensual', href: '/informe-mensual' },
  { title: 'Mis Evaluaciones', href: '/mis-evaluaciones' },
  { title: 'Mensajes', href: '/messages' },
  { title: 'Anuncios', href: '/announcements' },
  { title: 'Configuración', href: '/settings' },
];

/** El menú clásico podado por moduleKey (mismo criterio que filterByModuleOverride). */
export function menuClasicoFiltrado(isModuleEnabled: (key: string) => boolean): { items: EntradaNav[] }[] {
  return [{ items: MENU_COACH_CLASICO.filter((i) => !i.moduleKey || isModuleEnabled(i.moduleKey)) }];
}

/** Rutas de la barra inferior del coach en producción (MobileBottomNav.tsx, caso 'coach'). */
export const BARRA_COACH_PRODUCCION = ['/dashboard', '/coach-attendance', '/teams', '/messages', '/profile'];

/**
 * Pizarra libre: dibujar una jugada sin formulario ni sesión (la pantalla
 * independiente que deja el trabajo de la pizarra). Va SIEMPRE y PRIMERA en
 * «Entrenamiento».
 */
export const RUTA_PIZARRA = '/pizarra';

/**
 * Rutas que en «Más» quedan dentro de OTRA fila (no se pierden: se llega a lo
 * mismo). «Mi perfil» repetía los datos de «Configuración» (que ya trae
 * Perfil, Notificaciones, Seguridad y Privacidad), así que es una sola fila.
 */
export const RUTAS_UNIDAS: Record<string, string> = {
  '/profile': '/settings',
};

/** Dónde queda cada entrada del menú del coach en «Más», con palabras de la cancha. */
export const ENTRADAS_MAS: Record<string, { grupo: GrupoMas; label: string; nota?: string }> = {
  '/coach-plans': { grupo: 'Mi trabajo', label: 'Agenda y citas', nota: 'Citas 1 a 1' },
  '/calendar': { grupo: 'Mi trabajo', label: 'Calendario', nota: 'Entrenos, partidos y eventos' },
  '/informe-mensual': { grupo: 'Mi trabajo', label: 'Informe mensual', nota: 'El de cada deportista' },
  '/coach-reports': { grupo: 'Mi trabajo', label: 'Informes del entreno', nota: 'Cómo le fue al equipo' },
  '/mis-evaluaciones': { grupo: 'Mi trabajo', label: 'Mis evaluaciones', nota: 'Cómo te calificó la escuela' },
  [RUTA_PIZARRA]: { grupo: 'Entrenamiento', label: 'Pizarra', nota: 'Dibuja una jugada' },
  '/school/routines': { grupo: 'Entrenamiento', label: 'Rutinas', nota: 'Biblioteca de la escuela' },
  '/coach/dotacion': { grupo: 'Entrenamiento', label: 'Mi dotación', nota: 'Lo que tienes a cargo' },
  '/disponibilidad-medica': { grupo: 'Entrenamiento', label: 'Salud del equipo', nota: 'Quién puede entrenar' },
  '/messages': { grupo: 'Comunicación', label: 'Mensajes' },
  '/announcements': { grupo: 'Comunicación', label: 'Anuncios' },
  '/dashboard/polls': { grupo: 'Comunicación', label: 'Encuestas' },
  '/notifications': { grupo: 'Cuenta', label: 'Notificaciones' },
  '/settings': { grupo: 'Cuenta', label: 'Mi perfil y configuración', nota: 'Datos, contraseña y avisos' },
};

/** Filas que salen aunque el menú no las traiga. */
const SIEMPRE_EN_MAS = new Set([...BARRA_COACH_PRODUCCION, '/notifications', '/settings', RUTA_PIZARRA]);

export const ORDEN_GRUPOS: GrupoMas[] = ['Mi trabajo', 'Entrenamiento', 'Mis servicios', 'Comunicación', 'Otros', 'Ayuda', 'Cuenta'];

export function aplanar(items: EntradaNav[]): { title: string; href: string }[] {
  const out: { title: string; href: string }[] = [];
  for (const i of items) {
    if (i.href) out.push({ title: i.title, href: i.href });
    if (i.submenu) out.push(...aplanar(i.submenu));
  }
  return out;
}

export interface OpcionesMas {
  /** Grupos del menú del coach YA filtrados (getNavigationByRole). */
  menu: { items: EntradaNav[] }[];
  /** Grupo de vendedor si aplica (mismo criterio que AppSidebar: showVendorGroup). */
  servicios?: { title: string; items: EntradaNav[] } | null;
  whatsapp?: string | null;
  /** Tiene más de un rol o más de una escuela. */
  puedeCambiar?: boolean;
}

export function armarMas(o: OpcionesMas): { grupo: GrupoMas; filas: FilaMas[] }[] {
  const grupos = new Map<GrupoMas, FilaMas[]>();
  const vistos = new Set<string>();
  const add = (g: GrupoMas, f: FilaMas) => {
    const k = f.to ?? f.href ?? f.accion ?? f.label;
    if (vistos.has(k)) return;
    vistos.add(k);
    grupos.set(g, [...(grupos.get(g) ?? []), f]);
  };

  // 1. Menú real del coach (en el orden de ENTRADAS_MAS para que los grupos salgan ordenados).
  const delMenu = aplanar(o.menu.flatMap((g) => g.items));
  const enMenu = new Set(delMenu.map((i) => i.href));
  for (const [href, e] of Object.entries(ENTRADAS_MAS)) {
    // Las de la barra de producción (/messages, /profile), la pizarra y las de cuenta siempre están.
    if (enMenu.has(href) || SIEMPRE_EN_MAS.has(href)) add(e.grupo, { label: e.label, nota: e.nota, to: href });
  }
  for (const i of delMenu) {
    if (i.href === RUTA_MAS || RUTAS_EN_BARRA_COACH[i.href] || ENTRADAS_MAS[i.href] || RUTAS_UNIDAS[i.href]) continue;
    add('Otros', { label: i.title, to: i.href });
  }

  // 2. Mis servicios: solo si los activó (grupo de vendedor del menú lateral).
  if (o.servicios && o.servicios.items.length > 0) {
    const principal = aplanar(o.servicios.items)[0];
    if (principal) add('Mis servicios', { label: 'Mi tienda y servicios', nota: o.servicios.title, to: principal.href });
  }

  // 3. Ayuda.
  if (o.whatsapp) add('Ayuda', { label: 'Escribirle a la escuela', nota: 'WhatsApp', href: o.whatsapp });
  add('Ayuda', { label: 'Preguntarle a Mapi', nota: 'Asistente', accion: 'mapi' });
  add('Ayuda', { label: 'Centro de ayuda', to: '/ayuda' });

  // 4. Cuenta.
  if (o.puedeCambiar) add('Cuenta', { label: 'Cambiar de escuela o rol', to: '/elegir-rol' });
  add('Cuenta', { label: 'Cerrar sesión', accion: 'salir', peligro: true });

  return ORDEN_GRUPOS.filter((g) => (grupos.get(g)?.length ?? 0) > 0).map((g) => ({ grupo: g, filas: grupos.get(g)! }));
}

/** Todas las rutas alcanzables desde «Más» (para pruebas y auditoría). */
export function rutasDeMas(grupos: { filas: FilaMas[] }[]): string[] {
  return grupos.flatMap((g) => g.filas.map((f) => f.to).filter((x): x is string => !!x));
}
