/**
 * «Más» del deportista — quinta pestaña de la V2 (lienzo DepMas).
 *
 * Regla: ninguna entrada que el deportista tenía en producción se pierde. Lo
 * que no va en la barra (Hoy · Entrenos · Progreso · Carnet · Más) vive aquí:
 *   menú lateral (config/navigation.ts, bloque athlete) → Mis Pagos, Mi
 *   Calendario, Estadísticas (en Progreso), Objetivos, Entrenamientos (en
 *   Entrenos), Mis Inscripciones, Mis Eventos, Mi Salud, Mis Citas, Explorar
 *   Bienestar (= Mis medidas), Tienda, Mis compras, Mis Carnets (pestaña
 *   Carnet), Configuración; barra (MobileBottomNav caso athlete) → Perfil.
 *   Explorar está apagado (SHOW_EXPLORE): no se pone.
 *
 * Pagos SOLO si paga lo suyo (mayor de edad o pagador explícito). El menor no
 * la ve: la maneja su acudiente (decisión 6).
 *
 * Mis documentos: el catálogo de lib/documentosDeportista sin los del
 * acudiente. Hoy el deportista adulto NO tiene carpeta donde subir que la
 * escuela pueda leer (la policy de storage de identity-documents solo abre a
 * la escuela children/{acudiente}/{hijo}/…): se muestra «Pronto». El menor los
 * ve en solo lectura: los sube su acudiente.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useMySchoolStore } from '@/hooks/useMySchoolStore';
import { supabase } from '@/integrations/supabase/client';
import { cn, formatCurrency } from '@/lib/utils';
import { whatsappDeLaEscuela } from '@/lib/whatsappEscuela';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { sumDue } from '@/components/parent/v2/pagosModel';
import { iniciales } from '@/components/parent/v2/parentHomeLogic';
import { Pill } from '@/components/parent/v2/hijos/parts';
import { DOCUMENTOS_PROPIOS, ESPACIO_BOTON_FLOTANTE, cobrosPorPagar } from './athleteV2Model';
import { useAthleteTeams } from './useAthleteV2Data';
import { useDeportista } from './useDeportista';

interface Fila {
  label: string;
  nota?: string;
  to?: string;
  href?: string;
  onClick?: () => void;
  peligro?: boolean;
}

function Grupo({ titulo, filas }: { titulo: string; filas: Fila[] }) {
  if (filas.length === 0) return null;
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

export interface AthleteMorePageProps {
  /** A dónde lleva «Pagos» (AthletePaymentsV2). */
  pagosHref?: string;
}

export function AthleteMorePage({ pagosHref = '/athlete-payments' }: AthleteMorePageProps) {
  const { signOut, roleContexts } = useAuth();
  const { schoolId, schoolName } = useSchoolContext();
  const { showStore, showMyPurchases } = useMySchoolStore();
  const d = useDeportista();
  const teams = useAthleteTeams(d.userId);
  const [docs, setDocs] = useState(false);

  const { data: phone } = useQuery({
    queryKey: ['athlete-more-school-phone', schoolId],
    enabled: !!schoolId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from('schools').select('phone').eq('id', schoolId!).maybeSingle();
      return (data?.phone as string | null) ?? null;
    },
  });
  const whatsapp = whatsappDeLaEscuela(phone);
  const nombre = d.nombre || 'Tu cuenta';
  const equipo = teams.data?.[0];
  const sub = ['Deportista', equipo?.nombre, equipo?.escuela ?? schoolName].filter(Boolean).join(' · ');

  const porPagar = d.paga ? cobrosPorPagar(d.cobros.data?.transacciones ?? []) : [];
  const notaPagos = !d.paga ? undefined
    : d.cobros.isError ? 'No cargó'
      : !d.cobros.data ? undefined
        : porPagar.length > 0 ? `Debes ${formatCurrency(sumDue(porPagar))}` : 'Al día';

  const plata: Fila[] = d.paga ? [{ label: 'Pagos', nota: notaPagos, to: pagosHref }] : [];
  const actividad: Fila[] = [
    { label: 'Inscripciones y planes', nota: equipo?.nombre, to: '/enrollments' },
    { label: 'Calendario del mes', to: '/calendar' },
    { label: 'Torneos y eventos', to: '/my-event-registrations' },
    { label: 'Mis objetivos', to: '/goals' },
    { label: 'Mis documentos', nota: d.edad === 'menor' ? 'Los sube tu acudiente' : 'Pronto', onClick: () => setDocs(true) },
  ];
  const bienestar: Fila[] = [
    { label: 'Mi salud', to: '/salud' },
    { label: 'Mis citas', to: '/wellness/appointments' },
    { label: 'Mis medidas', nota: 'Peso, talla', to: '/wellness' },
  ];
  const tienda: Fila[] = [
    ...(showStore ? [{ label: 'Tienda del club', to: '/mi-tienda' }] : []),
    ...(showMyPurchases ? [{ label: 'Mis compras', to: '/mis-compras' }] : []),
  ];
  const ayuda: Fila[] = [
    ...(whatsapp ? [{ label: 'Escribirle al club', nota: 'WhatsApp', href: whatsapp }] : []),
    { label: 'Centro de ayuda', to: '/ayuda' },
  ];
  const cuenta: Fila[] = [
    { label: 'Notificaciones', to: '/notifications' },
    { label: 'Mis datos', to: '/profile' },
    { label: 'Configuración', nota: 'Avisos y contraseña', to: '/settings' },
    // Persona deportista Y acudiente (cambio-de-rol-atleta-acudiente.md): sin esta fila, en el
    // celular el único camino era el selector del inicio de sesión.
    ...(roleContexts.length > 1 ? [{ label: 'Cambiar de rol', nota: 'Deportista · Acudiente', to: '/elegir-rol' }] : []),
    { label: 'Cerrar sesión', onClick: () => { void signOut(); }, peligro: true },
  ];

  return (
    <div className="mx-auto max-w-page-narrow space-y-4 pb-nav-safe">
      <div className="flex items-center gap-3">
        <div className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-bold text-primary">
          {iniciales(nombre)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{nombre}</h1>
          <p className="truncate text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
      <Grupo titulo="Mi plata" filas={plata} />
      <Grupo titulo="Mi actividad" filas={actividad} />
      <Grupo titulo="Bienestar" filas={bienestar} />
      <Grupo titulo="Tienda" filas={tienda} />
      <Grupo titulo="Ayuda" filas={ayuda} />
      <Grupo titulo="Cuenta" filas={cuenta} />
      <p className="text-center text-xs text-muted-foreground">Powered by SportMaps</p>
      {/* Aire al final: el botón flotante de Mapi/soporte no tapa «Cerrar sesión». */}
      <div aria-hidden data-testid="espacio-boton-flotante" className={ESPACIO_BOTON_FLOTANTE} />

      <Sheet open={docs} onOpenChange={setDocs}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>Mis documentos</SheetTitle>
            <SheetDescription>
              {d.edad === 'menor'
                ? 'Tu acudiente los sube desde su app. Ninguno es obligatorio.'
                : 'Muy pronto podrás subirlos aquí, una sola vez, y la escuela no te los vuelve a pedir. Mientras tanto, si la escuela te los pide, envíaselos por WhatsApp.'}
            </SheetDescription>
          </SheetHeader>
          <ul className="mt-4 overflow-hidden rounded-2xl border bg-card">
            {DOCUMENTOS_PROPIOS.map((doc, i) => (
              <li key={doc.tipo} className={cn('flex min-h-touch items-center gap-3 px-4 py-2', i > 0 && 'border-t')}>
                <span className="flex-1 text-sm">{doc.label.replace(' del deportista', '')}</span>
                <Pill tone="neutral">{d.edad === 'menor' ? 'Acudiente' : 'Pronto'}</Pill>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default AthleteMorePage;
