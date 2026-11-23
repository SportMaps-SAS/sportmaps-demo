import { describe, it, expect } from 'vitest';
import {
  buildSchoolChecklist,
  buildSchoolNextLevel,
  buildVenueChecklist,
  buildParentChecklist,
  readChecklistCollapsed,
  writeChecklistCollapsed,
  markPaymentsViewed,
  hasViewedPayments,
  markVenueLinkShared,
  hasSharedVenueLink,
} from './onboardingChecklists';

const memoria = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const roto = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };

describe('buildSchoolChecklist', () => {
  it('tiene 6 pasos en el orden plan → deportista → cobro → medio de pago → familias → entrenador', () => {
    expect(buildSchoolChecklist({}).map((s) => s.id)).toEqual([
      'create_plan', 'add_student', 'see_charge', 'payment_method', 'invite_families', 'invite_staff',
    ]);
  });

  it('una academia vacía no tiene nada hecho', () => {
    expect(buildSchoolChecklist({}).every((s) => !s.completed)).toBe(true);
  });

  it('marca por lo que existe, no por clics', () => {
    const s = buildSchoolChecklist(
      { has_plans: true, has_students: true, has_charges: true, payment_setup_completed: true, has_staff: true },
      { has_families: true },
    );
    expect(s.every((x) => x.completed)).toBe(true);
  });

  it('el paso 1 se cumple con un plan O con un equipo', () => {
    expect(buildSchoolChecklist({ has_teams: true })[0].completed).toBe(true);
    expect(buildSchoolChecklist({ has_plans: true })[0].completed).toBe(true);
  });

  it('el paso 1 va a /teams solo si el modelo es por equipos', () => {
    expect(buildSchoolChecklist({ business_model: 'teams' })[0].href).toBe('/teams');
    expect(buildSchoolChecklist({ business_model: 'plans' })[0].href).toBe('/offerings');
    expect(buildSchoolChecklist({ business_model: 'both' })[0].href).toBe('/offerings');
    expect(buildSchoolChecklist({})[0].href).toBe('/offerings');
  });

  it('el cobro y las familias exigen el dato explícito (undefined = pendiente)', () => {
    const s = buildSchoolChecklist({ has_charges: undefined }, {});
    expect(s.find((x) => x.id === 'see_charge')!.completed).toBe(false);
    expect(s.find((x) => x.id === 'invite_families')!.completed).toBe(false);
  });

  it('ningún paso apunta a /dashboard (el clic debe llevar a su pantalla)', () => {
    expect(buildSchoolChecklist({}).every((s) => s.href !== '/dashboard' && s.href.startsWith('/'))).toBe(true);
  });
});

describe('buildSchoolNextLevel', () => {
  it('la dirección de la sede es opcional y no cuenta en los 6', () => {
    expect(buildSchoolNextLevel({ branch_confirmed: false })[0].completed).toBe(false);
    expect(buildSchoolNextLevel({ branch_confirmed: true })[0].completed).toBe(true);
    expect(buildSchoolChecklist({}).some((s) => s.id === 'confirm_branch')).toBe(false);
  });
});

describe('buildVenueChecklist', () => {
  it('tiene 4 pasos y marca por lo que existe', () => {
    const vacio = buildVenueChecklist({}, { linkShared: false });
    expect(vacio.map((s) => s.id)).toEqual(['venue_facility', 'venue_link', 'venue_reservation', 'venue_payments']);
    expect(vacio.every((s) => !s.completed)).toBe(true);
    const lleno = buildVenueChecklist(
      { has_facility: true, has_reservation: true, has_payment_method: true },
      { linkShared: false },
    );
    expect(lleno.every((s) => s.completed)).toBe(true);
  });

  it('el enlace cuenta si se copió o si ya llegó una reserva', () => {
    expect(buildVenueChecklist({}, { linkShared: true })[1].completed).toBe(true);
    expect(buildVenueChecklist({ has_reservation: true }, { linkShared: false })[1].completed).toBe(true);
    expect(buildVenueChecklist({}, { linkShared: false })[1].completed).toBe(false);
  });
});

describe('buildParentChecklist', () => {
  it('tiene 3 pasos; quien llega por invitación aceptada arranca con el 1 hecho', () => {
    const s = buildParentChecklist({ has_accepted_invite: true }, { viewedPayments: false });
    expect(s.map((x) => x.id)).toEqual(['connect_school', 'review_athlete', 'see_payments']);
    expect(s[0].completed).toBe(true);
    expect(s[1].completed).toBe(false);
  });

  it('con invitación pendiente el paso 1 lleva a las notificaciones; si no, a /unirse', () => {
    expect(buildParentChecklist({ has_pending_invitation: true }, { viewedPayments: false })[0].href).toBe('/notifications');
    expect(buildParentChecklist({}, { viewedPayments: false })[0].href).toBe('/unirse');
  });

  it('revisar al deportista pide hijo Y ficha médica', () => {
    expect(buildParentChecklist({ has_children: true }, { viewedPayments: false })[1].completed).toBe(false);
    expect(buildParentChecklist({ has_children: true, has_medical_records: true }, { viewedPayments: false })[1].completed).toBe(true);
  });

  it('mirar pagos depende de haber abierto la pantalla', () => {
    expect(buildParentChecklist({}, { viewedPayments: true })[2].completed).toBe(true);
  });
});

describe('estado colapsado y marcas del dispositivo', () => {
  it('se colapsa y se reabre', () => {
    const st = memoria();
    expect(readChecklistCollapsed('escuela', st)).toBe(false);
    writeChecklistCollapsed('escuela', true, st);
    expect(readChecklistCollapsed('escuela', st)).toBe(true);
    writeChecklistCollapsed('escuela', false, st);
    expect(readChecklistCollapsed('escuela', st)).toBe(false);
  });

  it('cada checklist guarda lo suyo', () => {
    const st = memoria();
    writeChecklistCollapsed('escuela', true, st);
    expect(readChecklistCollapsed('acudiente', st)).toBe(false);
  });

  it('sin storage (bloqueado o ausente) no lanza y queda abierto', () => {
    expect(() => writeChecklistCollapsed('x', true, roto)).not.toThrow();
    expect(readChecklistCollapsed('x', roto)).toBe(false);
    expect(readChecklistCollapsed('x', null)).toBe(false);
    expect(hasViewedPayments(roto)).toBe(false);
    expect(hasSharedVenueLink('s', roto)).toBe(false);
    expect(() => markPaymentsViewed(roto)).not.toThrow();
    expect(() => markVenueLinkShared('s', roto)).not.toThrow();
  });

  it('recuerda que se abrió Pagos y que se copió el enlace (por escuela)', () => {
    const st = memoria();
    expect(hasViewedPayments(st)).toBe(false);
    markPaymentsViewed(st);
    expect(hasViewedPayments(st)).toBe(true);
    markVenueLinkShared('s1', st);
    expect(hasSharedVenueLink('s1', st)).toBe(true);
    expect(hasSharedVenueLink('s2', st)).toBe(false);
  });
});
