/**
 * «Más» del entrenador — quinta pestaña de la V2 (lienzo «CoaMas»).
 *
 * Lo que se usa pocas veces, en grupos: Mi trabajo, Entrenamiento, Mis servicios,
 * Comunicación (Mensajes, Anuncios, Encuestas: decisión 1 del usuario), Ayuda y Cuenta.
 * Ninguna entrada del menú actual se pierde: sale del menú real filtrado por
 * moduleKey / adicionales / tienda (coachMasModel.ts). Patrón: ParentMorePage.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useStoreEnabled } from '@/hooks/useStoreEnabled';
import { useVendorProfile } from '@/hooks/useVendorProfile';
import { supabase } from '@/integrations/supabase/client';
import { getNavigationByRole, getVendorNavGroup } from '@/config/navigation';
import { whatsappDeLaEscuela } from '@/lib/whatsappEscuela';
import { cn } from '@/lib/utils';
import { SupportChatModal } from '@/components/support/SupportChatModal';
import { armarMas, menuClasicoFiltrado, type FilaMas } from './coachMasModel';
import { iniciales } from './asistenciaModel';

function Grupo({ titulo, filas, onAccion }: { titulo: string; filas: FilaMas[]; onAccion: (a: FilaMas['accion']) => void }) {
  return (
    <section className="space-y-1.5">
      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{titulo}</h2>
      <div className="overflow-hidden rounded-2xl border bg-card">
        {filas.map((f, i) => {
          const contenido = (
            <>
              <span className={cn('min-w-0 flex-1 break-words text-base', f.peligro && 'text-destructive')}>{f.label}</span>
              {f.nota && <span className="min-w-0 max-w-[45%] shrink truncate text-right text-xs text-muted-foreground">{f.nota}</span>}
              {!f.peligro && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </>
          );
          const clase = cn('flex min-h-touch w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-muted/50', i > 0 && 'border-t');
          if (f.to) return <Link key={f.label} to={f.to} className={clase} data-ruta={f.to}>{contenido}</Link>;
          if (f.href) return <a key={f.label} href={f.href} target="_blank" rel="noopener noreferrer" className={clase}>{contenido}</a>;
          return <button key={f.label} type="button" onClick={() => onAccion(f.accion)} className={clase}>{contenido}</button>;
        })}
      </div>
    </section>
  );
}

export default function CoachMorePage() {
  const { profile, signOut, roleContexts } = useAuth();
  const { schoolId, schoolName, availableSchools } = useSchoolContext();
  const { hasAddon, isModuleEnabled } = useEntitlements();
  const { enabled: storeEnabled } = useStoreEnabled();
  const { hasVendorProfile, canSellProducts, canSellServices, verificationStatus } = useVendorProfile();
  const [mapi, setMapi] = useState(false);

  // schools.phone es de lectura para los miembros (school_settings no: trae datos bancarios).
  const { data: phone } = useQuery({
    queryKey: ['coach-more-school-phone', schoolId],
    enabled: !!schoolId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from('schools').select('phone').eq('id', schoolId!).maybeSingle();
      return (data?.phone as string | null) ?? null;
    },
  });

  // Mismo criterio que AppSidebar: el coach ve «Mis servicios» solo si tiene perfil de vendedor
  // y (la tienda está prendida o vende servicios).
  const servicios = hasVendorProfile && (storeEnabled || canSellServices)
    ? getVendorNavGroup({ canSellProducts, canSellServices, verificationStatus, storeEnabled })
    : null;
  const escuelas = new Set((availableSchools ?? []).map((s) => s.schoolId));
  const grupos = armarMas({
    // El menú clásico completo (podado por moduleKey) + lo que traiga el menú actual del coach.
    menu: [...menuClasicoFiltrado(isModuleEnabled as (k: string) => boolean), ...getNavigationByRole('coach', hasAddon, isModuleEnabled, storeEnabled)],
    servicios,
    whatsapp: whatsappDeLaEscuela(phone),
    puedeCambiar: roleContexts.length > 0 || escuelas.size > 1,
  });

  const nombre = profile?.full_name || 'Tu cuenta';
  const onAccion = (a: FilaMas['accion']) => {
    if (a === 'mapi') setMapi(true);
    if (a === 'salir') void signOut();
  };

  return (
    <div className="mx-auto max-w-page-narrow space-y-4 px-gutter pb-nav-safe pt-5 md:pb-8">
      <div className="flex items-center gap-3">
        <div className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-bold text-primary">
          {iniciales(nombre)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{nombre}</h1>
          <p className="truncate text-xs text-muted-foreground">Entrenador{schoolName ? ` · ${schoolName}` : ''}</p>
        </div>
      </div>
      {grupos.map((g) => <Grupo key={g.grupo} titulo={g.grupo} filas={g.filas} onAccion={onAccion} />)}
      <p className="text-center text-xs text-muted-foreground">Powered by SportMaps</p>
      <SupportChatModal isOpen={mapi} onClose={() => setMapi(false)} />
    </div>
  );
}
