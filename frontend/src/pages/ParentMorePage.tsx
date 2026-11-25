/**
 * «Más» del acudiente — quinta pestaña de la V2 (docs/specs/modulos-v2-definicion.md §4.6;
 * tablero «AcuMas» del lienzo del rediseño).
 *
 * Lo que se usa pocas veces, en tres grupos: Mi familia, Ayuda y Cuenta.
 *
 * Regla: la V2 NO le quita al acudiente ningún módulo que tenía en producción.
 * Todo lo que estaba en el menú anterior y no cabe en las otras cuatro
 * pestañas vive aquí (mensajes, eventos, constancias, citas, explorar, perfil).
 * El débito automático sigue donde estaba, en Pagos. «Activar Mi Tienda» no aplica: ActivateStoreCTA nunca se
 * mostraba al rol parent (ELIGIBLE_ROLES). La tienda solo aparece si la escuela
 * activa vende (useMySchoolStore, igual que el menú lateral).
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useMySchoolStore } from '@/hooks/useMySchoolStore';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { whatsappDeLaEscuela } from '@/lib/whatsappEscuela';
import { SHOW_EXPLORE } from '@/lib/feature-flags';

function iniciales(nombre: string): string {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

interface Fila {
  label: string;
  nota?: string;
  to?: string;
  href?: string;
  onClick?: () => void;
  peligro?: boolean;
}

function Grupo({ titulo, filas }: { titulo: string; filas: Fila[] }) {
  return (
    <section className="space-y-1.5">
      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{titulo}</h2>
      <div className="overflow-hidden rounded-2xl border bg-card">
        {filas.map((f, i) => {
          const contenido = (
            <>
              <span className={cn('flex-1 text-base', f.peligro && 'text-destructive')}>{f.label}</span>
              {f.nota && <span className="text-xs text-muted-foreground">{f.nota}</span>}
              {!f.peligro && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            </>
          );
          const clase = cn('flex min-h-touch w-full items-center gap-3 px-4 text-left hover:bg-muted/50', i > 0 && 'border-t');
          if (f.to) return <Link key={f.label} to={f.to} className={clase}>{contenido}</Link>;
          if (f.href) return <a key={f.label} href={f.href} target="_blank" rel="noopener noreferrer" className={clase}>{contenido}</a>;
          return <button key={f.label} type="button" onClick={f.onClick} className={clase}>{contenido}</button>;
        })}
      </div>
    </section>
  );
}

export default function ParentMorePage() {
  const { profile, signOut } = useAuth();
  const { schoolId, schoolName } = useSchoolContext();
  const { showStore, showMyPurchases } = useMySchoolStore({ enabled: !!profile });

  // schools.phone es de lectura para los miembros (school_settings no: trae datos bancarios).
  const { data: phone } = useQuery({
    queryKey: ['parent-more-school-phone', schoolId],
    enabled: !!schoolId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from('schools').select('phone').eq('id', schoolId!).maybeSingle();
      return (data?.phone as string | null) ?? null;
    },
  });
  const whatsapp = whatsappDeLaEscuela(phone);
  const nombre = profile?.full_name || 'Tu cuenta';

  const familia: Fila[] = [
    { label: 'Inscripciones y planes', to: '/enrollments' },
    { label: 'Mis eventos y torneos', to: '/my-event-registrations' },
    { label: 'Carnets', to: '/my-cards' },
    { label: 'Constancias', nota: 'Paz y salvo, inscripción', to: '/my-certificates' },
    ...(showStore ? [{ label: 'Tienda del club', to: '/mi-tienda' }] : []),
    ...(showMyPurchases ? [{ label: 'Mis compras', to: '/mis-compras' }] : []),
    { label: 'Salud de mis hijos', to: '/salud' },
    { label: 'Mis citas', to: '/wellness/appointments' },
    ...(SHOW_EXPLORE ? [{ label: 'Explorar', to: '/explorar' }] : []),
  ];
  const ayuda: Fila[] = [
    ...(whatsapp ? [{ label: 'Escribirle al club', nota: 'WhatsApp', href: whatsapp }] : []),
    { label: 'Mensajes', to: '/messages' },
    { label: 'Centro de ayuda', to: '/ayuda' },
  ];
  const cuenta: Fila[] = [
    { label: 'Notificaciones', to: '/notifications' },
    // Mi perfil y Configuración pedían los mismos datos: una sola «Mi cuenta».
    { label: 'Mi cuenta', nota: 'Datos, avisos y contraseña', to: '/settings' },
    { label: 'Cerrar sesión', onClick: () => { void signOut(); }, peligro: true },
  ];

  return (
    <div className="mx-auto max-w-page-narrow space-y-4 px-4 py-5">
      <div className="flex items-center gap-3">
        <div className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-bold text-primary">
          {iniciales(nombre)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{nombre}</h1>
          <p className="truncate text-xs text-muted-foreground">Acudiente{schoolName ? ` · ${schoolName}` : ''}</p>
        </div>
      </div>
      <Grupo titulo="Mi familia" filas={familia} />
      <Grupo titulo="Ayuda" filas={ayuda} />
      <Grupo titulo="Cuenta" filas={cuenta} />
      <p className="text-center text-xs text-muted-foreground">Powered by SportMaps</p>
    </div>
  );
}
