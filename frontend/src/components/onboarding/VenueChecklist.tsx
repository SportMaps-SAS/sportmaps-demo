import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building, Link2, CalendarCheck, CreditCard, Circle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { DashboardChecklist } from '@/components/dashboard/DashboardChecklist';
import {
  buildVenueChecklist,
  hasSharedVenueLink,
  markVenueLinkShared,
  type ChecklistExtras,
} from '@/lib/onboarding/onboardingChecklists';

const ICONOS: Record<string, React.ElementType> = {
  venue_facility: Building,
  venue_link: Link2,
  venue_reservation: CalendarCheck,
  venue_payments: CreditCard,
};

interface Props {
  schoolId: string | null;
  /** Reservas ya leídas por el panel: evita una consulta más. */
  hasReservation: boolean;
}

/**
 * Checklist del Club / Canchas, «3 de 4». Se muestra en el inicio mientras falte
 * algún paso; los pasos se marcan por lo que existe en la base. «Comparte tu
 * enlace» copia el enlace público de reservas.
 */
export function VenueChecklist({ schoolId, hasReservation }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [extras, setExtras] = useState<ChecklistExtras | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [linkShared, setLinkShared] = useState(() => (schoolId ? hasSharedVenueLink(schoolId) : false));

  useEffect(() => {
    if (!schoolId) return;
    let vivo = true;
    (async () => {
      try {
        const { data } = await supabase.rpc(
          'get_onboarding_checklist_extras' as never,
          { p_school_id: schoolId } as never,
        );
        const e = data as (ChecklistExtras & { ok?: boolean }) | null;
        if (vivo && e?.ok) setExtras(e);
      } catch {
        /* sin la migración, el checklist no se muestra */
      }
      const { data: s } = await supabase.from('schools').select('slug').eq('id', schoolId).maybeSingle();
      if (vivo) setSlug((s as { slug?: string | null } | null)?.slug ?? null);
    })();
    return () => { vivo = false; };
  }, [schoolId]);

  const steps = useMemo(() => {
    if (!extras) return [];
    const items = buildVenueChecklist(
      { ...extras, has_reservation: extras.has_reservation === true || hasReservation },
      { linkShared },
    );
    return items.map((i) => ({ ...i, icon: ICONOS[i.id] ?? Circle }));
  }, [extras, hasReservation, linkShared]);

  if (steps.length === 0 || steps.every((s) => s.completed)) return null;

  const onStep = async (step: { id: string; href: string }) => {
    if (step.id === 'venue_link' && slug && schoolId) {
      const url = `${window.location.origin}/reservar/${slug}`;
      try {
        await navigator.clipboard.writeText(url);
        markVenueLinkShared(schoolId);
        setLinkShared(true);
        toast({ title: 'Enlace copiado', description: 'Pégalo donde te escriben tus clientes.' });
      } catch {
        toast({ title: 'Tu enlace de reservas', description: url });
      }
      return;
    }
    navigate(step.href);
  };

  return (
    <DashboardChecklist
      steps={steps as never}
      title="Pon a andar tu espacio"
      subtitle="Te faltan pocos pasos para recibir reservas."
      collapsibleId="club"
      onStepClick={onStep as never}
    />
  );
}
