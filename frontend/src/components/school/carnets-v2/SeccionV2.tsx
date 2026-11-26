/** Bloque de sección de la pantalla V2: rótulo arriba y tarjeta blanca debajo (lienzo DueCarnets). */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function SeccionV2({ titulo, children, className, id }: { titulo: string; children: ReactNode; className?: string; id?: string }) {
  const tituloId = id ? `${id}-titulo` : undefined;
  return (
    <section className={cn('flex flex-col gap-1.5', className)} aria-labelledby={tituloId}>
      <h2 id={tituloId} className="px-1 text-[13px] font-semibold text-muted-foreground">{titulo}</h2>
      <div className="overflow-hidden rounded-2xl border bg-card">{children}</div>
    </section>
  );
}

/** Fila tocable de 52–60 px con flecha (enlace o botón). */
export function FilaV2({
  titulo, detalle, onClick, href, icono,
}: { titulo: string; detalle?: string; onClick?: () => void; href?: string; icono?: ReactNode }) {
  const cuerpo = (
    <>
      {icono}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-[15px] font-medium">{titulo}</span>
        {detalle && <span className="text-xs text-muted-foreground">{detalle}</span>}
      </span>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-muted-foreground"><path d="M9 6l6 6-6 6" /></svg>
    </>
  );
  const cls = 'flex min-h-[56px] w-full items-center gap-3 border-t px-3.5 py-2 first:border-t-0 transition-colors hover:bg-muted/50 active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  if (href) {
    return <Link to={href} className={cls}>{cuerpo}</Link>;
  }
  return <button type="button" onClick={onClick} className={cls}>{cuerpo}</button>;
}

/** Semáforo decorativo de «Reglas para entrar». */
export function PuntosSemaforo() {
  return (
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      <span className="h-2.5 w-2.5 rounded-full bg-[#2E9E3A]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#E8A317]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#C8372D]" />
    </span>
  );
}
