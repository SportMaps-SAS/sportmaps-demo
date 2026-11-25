import { describe, expect, it } from 'vitest';
import { isBranchConfirmed, isSchoolWizardStepDone, shouldShowSchoolChecklist, isWizardStepRequired, schoolHasSport } from './schoolOnboardingRules';
import { getStepsForRole } from './getStepsForRole';

describe('isBranchConfirmed (hallazgo B)', () => {
  it('con la sede automática y sin dirección, el paso NO está hecho', () => {
    expect(isBranchConfirmed({ has_branches: true, branch_confirmed: false })).toBe(false);
  });
  it('con dirección, está hecho', () => {
    expect(isBranchConfirmed({ has_branches: true, branch_confirmed: true })).toBe(true);
  });
  it('si la base aún no envía branch_confirmed, se comporta como antes', () => {
    expect(isBranchConfirmed({ has_branches: true })).toBe(true);
    expect(isBranchConfirmed({ has_branches: false })).toBe(false);
    expect(isBranchConfirmed({})).toBe(false);
  });
});

describe('isSchoolWizardStepDone', () => {
  const nueva = { has_branches: true, branch_confirmed: false };
  it('una academia recién creada no tiene ningún paso hecho', () => {
    for (const id of ['branch', 'model', 'team', 'plan', 'coach', 'student', 'payments'] as const) {
      expect(isSchoolWizardStepDone(id, nueva)).toBe(false);
    }
  });
  it('«Modelo» se da por hecho con un equipo o con un plan', () => {
    expect(isSchoolWizardStepDone('model', { has_teams: true })).toBe(true);
    expect(isSchoolWizardStepDone('model', { has_plans: true })).toBe(true);
  });
  it('cada paso mira su propia señal', () => {
    expect(isSchoolWizardStepDone('coach', { has_staff: true })).toBe(true);
    expect(isSchoolWizardStepDone('student', { has_students: true })).toBe(true);
    expect(isSchoolWizardStepDone('payments', { payment_setup_completed: true })).toBe(true);
    expect(isSchoolWizardStepDone('payments', { has_staff: true })).toBe(false);
  });
});

describe('shouldShowSchoolChecklist (hallazgo E)', () => {
  const pendientes = [{ completed: true }, { completed: false }];

  it('después del asistente y sin cobros todavía: se muestra', () => {
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: pendientes, hasCharges: false })).toBe(true);
  });
  it('con el primer cobro deja de mostrarse', () => {
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: pendientes, hasCharges: true })).toBe(false);
  });
  it('si la base no informa has_charges, no se le aparece a escuelas que ya operan', () => {
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: pendientes, hasCharges: undefined })).toBe(false);
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: pendientes, hasCharges: null })).toBe(false);
  });
  it('mientras el asistente no termina, manda el asistente', () => {
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'in_progress', steps: pendientes, hasCharges: false })).toBe(false);
    expect(shouldShowSchoolChecklist({ onboardingStatus: null, steps: pendientes, hasCharges: false })).toBe(false);
  });
  it('sin pasos o con todo hecho, no hay nada que mostrar', () => {
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: [], hasCharges: false })).toBe(false);
    expect(shouldShowSchoolChecklist({ onboardingStatus: 'completed', steps: [{ completed: true }], hasCharges: false })).toBe(false);
  });
});

describe('getStepsForRole — checklist de la academia (6 pasos)', () => {
  const status = {
    has_school: true,
    has_branches: true,
    branch_confirmed: false,
    business_model: 'both',
    has_teams: false,
    has_plans: true,
    has_staff: false,
    has_students: false,
    payment_setup_completed: false,
    has_charges: false,
    has_families: false,
  };
  const steps = getStepsForRole('school', status);
  const paso = (id: string) => steps.find((s) => s.id === id)!;

  it('son 6 pasos, en el orden de la propuesta, cada uno con ícono', () => {
    expect(steps.map((s) => s.id)).toEqual([
      'create_plan', 'add_student', 'see_charge', 'payment_method', 'invite_families', 'invite_staff',
    ]);
    expect(steps.every((s) => !!s.icon)).toBe(true);
  });
  it('cada paso lleva a la pantalla donde se resuelve, no de vuelta al panel', () => {
    expect(paso('create_plan').href).toBe('/offerings');
    expect(paso('add_student').href).toBe('/students');
    expect(paso('see_charge').href).toBe('/payments-automation');
    expect(paso('payment_method').href).toBe('/payments-automation?tab=config');
    expect(paso('invite_families').href).toBe('/students');
    expect(paso('invite_staff').href).toBe('/staff');
    expect(steps.some((s) => s.href === '/dashboard')).toBe(false);
  });
  it('refleja lo que ya existe', () => {
    expect(paso('create_plan').completed).toBe(true);
    expect(paso('add_student').completed).toBe(false);
  });
  it('un dueño sin escuela todavía solo ve «Registrar academia»', () => {
    expect(getStepsForRole('school', { has_school: false }).map((s) => s.id)).toEqual(['create_school']);
  });
});

describe('getStepsForRole — checklist del acudiente (3 pasos)', () => {
  it('quien llegó por invitación aceptada arranca con el paso 1 hecho', () => {
    const steps = getStepsForRole('parent', { has_accepted_invite: true });
    expect(steps.map((s) => s.id)).toEqual(['connect_school', 'review_athlete', 'see_payments']);
    expect(steps[0].completed).toBe(true);
    expect(steps.every((s) => !!s.icon)).toBe(true);
  });
});

describe('asistente corto', () => {
  it('solo el deporte bloquea; plan, equipo, modelo y el resto se pueden saltar', () => {
    expect(isWizardStepRequired('sport')).toBe(true);
    for (const id of ['branch', 'model', 'team', 'plan', 'coach', 'student', 'payments'] as const) {
      expect(isWizardStepRequired(id)).toBe(false);
    }
  });

  it('schoolHasSport: basta un deporte guardado o el del registro', () => {
    expect(schoolHasSport({})).toBe(false);
    expect(schoolHasSport({ schoolSports: [] })).toBe(false);
    expect(schoolHasSport({ schoolSports: ['  ', null] })).toBe(false);
    expect(schoolHasSport({ schoolSports: ['Voleibol'] })).toBe(true);
    expect(schoolHasSport({ schoolSports: ['Deporte raro fuera del catálogo'] })).toBe(true);
    expect(schoolHasSport({ metadataSport: 'Fútbol' })).toBe(true);
    expect(schoolHasSport({ metadataSport: '   ' })).toBe(false);
    expect(schoolHasSport({ metadataSport: 42 })).toBe(false);
  });
});
