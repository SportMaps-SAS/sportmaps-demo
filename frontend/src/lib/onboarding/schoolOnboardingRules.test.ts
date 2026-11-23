import { describe, expect, it } from 'vitest';
import { isBranchConfirmed, isSchoolWizardStepDone, shouldShowSchoolChecklist } from './schoolOnboardingRules';
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

describe('getStepsForRole — pasos de la academia', () => {
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
  };
  const steps = getStepsForRole('school', status);
  const paso = (id: string) => steps.find((s) => s.id === id)!;

  it('«Tu sede» no se marca solo porque exista la sede automática', () => {
    expect(paso('confirm_branch').completed).toBe(false);
  });
  it('cada paso lleva a la pantalla donde se resuelve, no de vuelta al panel', () => {
    expect(paso('confirm_branch').href).toBe('/branches');
    expect(paso('create_team').href).toBe('/teams');
    expect(paso('create_plan').href).toBe('/offerings');
    expect(paso('invite_staff').href).toBe('/staff');
    expect(paso('add_student').href).toBe('/students');
    expect(paso('setup_payments').href).toBe('/payments-automation?tab=config');
    expect(steps.some((s) => s.href === '/dashboard')).toBe(false);
  });
  it('refleja lo que ya existe', () => {
    expect(paso('create_plan').completed).toBe(true);
    expect(paso('create_team').completed).toBe(false);
  });
});
