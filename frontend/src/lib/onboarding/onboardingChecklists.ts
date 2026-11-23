// ============================================================================
// Checklists del panel, sin React ni íconos, para poder probarlos. Cada paso se
// marca por lo que EXISTE en la base (RPC get_onboarding_status y
// get_onboarding_checklist_extras), nunca por un clic. Lo que la base todavía no
// puede decir llega `undefined` y el paso queda pendiente.
// ============================================================================
import { isBranchConfirmed, type SchoolOnboardingStatusLike } from './schoolOnboardingRules';

export interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  href: string;
}

export interface ChecklistExtras {
  has_families?: boolean | null;
  has_facility?: boolean | null;
  has_reservation?: boolean | null;
  has_payment_method?: boolean | null;
}

export interface SchoolChecklistStatus extends SchoolOnboardingStatusLike {
  business_model?: 'teams' | 'plans' | 'both' | null;
}

/**
 * Checklist de la academia: plan → deportista → cobro → medio de pago →
 * familias → entrenador. El orden lo manda el primer cobro (docs/onboarding,
 * sección 2.2): los tres primeros se hacen en minutos y terminan con algo que la
 * academia reconoce como suyo.
 */
export function buildSchoolChecklist(status: SchoolChecklistStatus, extras: ChecklistExtras = {}): ChecklistItem[] {
  const soloEquipos = status.business_model === 'teams';
  return [
    {
      id: 'create_plan',
      title: 'Crea tu primer plan o grupo',
      description: 'Lo que vas a cobrar cada mes. Con el precio basta.',
      completed: !!status.has_plans || !!status.has_teams,
      href: soloEquipos ? '/teams' : '/offerings',
    },
    {
      id: 'add_student',
      title: 'Registra a tu primer deportista',
      description: 'Con su plan asignado, el cobro se crea solo.',
      completed: !!status.has_students,
      href: '/students',
    },
    {
      id: 'see_charge',
      title: 'Mira tu primer cobro',
      description: 'Así lo ve la familia. Aquí puedes registrar el pago.',
      completed: status.has_charges === true,
      href: '/payments-automation',
    },
    {
      id: 'payment_method',
      title: 'Dile a las familias cómo pagarte',
      description: 'Nequi, Bre-B o cuenta bancaria. Basta uno.',
      completed: status.payment_setup_completed === true,
      href: '/payments-automation?tab=config',
    },
    {
      id: 'invite_families',
      title: 'Invita a las familias',
      description: 'Para que cada acudiente vea a su deportista y su cobro.',
      completed: extras.has_families === true,
      href: '/students',
    },
    {
      id: 'invite_staff',
      title: 'Invita a tu entrenador',
      description: 'Para que alguien más tome la asistencia.',
      completed: !!status.has_staff,
      href: '/staff',
    },
  ];
}

/** Pasos opcionales («Siguiente nivel»): fuera del conteo de los 6. */
export function buildSchoolNextLevel(status: SchoolChecklistStatus): ChecklistItem[] {
  return [
    {
      id: 'confirm_branch',
      title: 'Completa la dirección de tu sede',
      description: 'Aparece en los avisos y en tu perfil público.',
      completed: isBranchConfirmed(status),
      href: '/branches',
    },
  ];
}

/** Checklist del Club / Canchas, «3 de 4» (docs/onboarding, sección 2.3). */
export function buildVenueChecklist(
  extras: ChecklistExtras,
  opts: { linkShared: boolean },
): ChecklistItem[] {
  return [
    {
      id: 'venue_facility',
      title: 'Tu primera cancha',
      description: 'Crea el espacio que vas a alquilar.',
      completed: extras.has_facility === true,
      href: '/venue/onboarding',
    },
    {
      id: 'venue_link',
      title: 'Comparte tu enlace de reservas',
      description: 'Cópialo y pégalo donde te escriben tus clientes.',
      // La primera reserva demuestra que el enlace ya circuló.
      completed: opts.linkShared || extras.has_reservation === true,
      href: '/venue/dashboard',
    },
    {
      id: 'venue_reservation',
      title: 'Recibe tu primera reserva',
      description: '¿Aún no llega? Crea una de prueba para ver cómo queda.',
      completed: extras.has_reservation === true,
      href: '/venue/reservas',
    },
    {
      id: 'venue_payments',
      title: 'Configura cómo te pagan',
      description: 'Para que cada reserva se pueda cobrar.',
      completed: extras.has_payment_method === true,
      href: '/venue/cobros',
    },
  ];
}

export interface ParentChecklistStatus {
  has_accepted_invite?: boolean | null;
  has_pending_invitation?: boolean | null;
  has_children?: boolean | null;
  has_medical_records?: boolean | null;
}

/**
 * Checklist del acudiente, «1 de 3» (docs/onboarding, sección 2.4).
 * `viewedPayments` es un dato del dispositivo (localStorage): abrir Pagos no deja
 * huella en la base. Se acepta porque es el último paso y solo orienta.
 */
export function buildParentChecklist(
  status: ParentChecklistStatus,
  opts: { viewedPayments: boolean },
): ChecklistItem[] {
  const conectado = !!status.has_accepted_invite || !!status.has_children;
  return [
    {
      id: 'connect_school',
      title: 'Conéctate con tu escuela',
      description: status.has_pending_invitation
        ? 'Tienes una invitación pendiente: acéptala.'
        : 'Escribe el código de tu escuela o escanea su QR.',
      completed: conectado,
      href: status.has_pending_invitation ? '/notifications' : '/unirse',
    },
    {
      id: 'review_athlete',
      title: 'Revisa a tu deportista',
      description: 'Verifica sus datos y sube su ficha médica.',
      completed: !!status.has_children && !!status.has_medical_records,
      href: '/children',
    },
    {
      id: 'see_payments',
      title: 'Mira tus pagos',
      description: 'Aquí pagas o subes tu comprobante.',
      completed: opts.viewedPayments,
      href: '/my-payments',
    },
  ];
}

// ── Checklist colapsable ─────────────────────────────────────────────────────
// Se colapsa a una píldora «2/6» y se reabre. Es una comodidad del dispositivo
// (localStorage), no un dato de negocio: si no hay storage queda abierto.

const KEY_PREFIX = 'sm_checklist_colapsado:';
const PAYMENTS_KEY = 'sm_checklist_pagos_visto';
const LINK_KEY = 'sm_checklist_enlace_copiado:';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readChecklistCollapsed(id: string, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY_PREFIX + id) === '1';
  } catch {
    return false;
  }
}

export function writeChecklistCollapsed(id: string, collapsed: boolean, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY_PREFIX + id, collapsed ? '1' : '0');
  } catch {
    /* sin storage: queda abierto */
  }
}

export function markPaymentsViewed(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(PAYMENTS_KEY, '1');
  } catch {
    /* ignorar */
  }
}

export function hasViewedPayments(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(PAYMENTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function markVenueLinkShared(schoolId: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(LINK_KEY + schoolId, '1');
  } catch {
    /* ignorar */
  }
}

export function hasSharedVenueLink(schoolId: string, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(LINK_KEY + schoolId) === '1';
  } catch {
    return false;
  }
}
