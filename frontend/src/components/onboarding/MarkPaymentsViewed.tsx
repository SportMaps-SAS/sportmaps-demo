import { useEffect } from 'react';
import { markPaymentsViewed } from '@/lib/onboarding/onboardingChecklists';

/** Deja constancia en el dispositivo de que el acudiente abrió Pagos (paso 3 de su checklist). */
export function MarkPaymentsViewed() {
  useEffect(() => {
    markPaymentsViewed();
  }, []);
  return null;
}
