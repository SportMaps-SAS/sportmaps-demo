/**
 * /e/:token — estado de cuenta de una familia, sin login.
 *
 * Es el destino del botón del correo «Ver mi estado de cuenta» que manda la
 * escuela (https://app.sportmaps.co/e/<token>). Muestra, por cada hijo y mes a
 * mes: lo que se cobró, la fecha límite, cuándo y cómo se pagó, la puntualidad y
 * la asistencia resumida. Es la MISMA pantalla V2 del estado de cuenta
 * (`EstadoCuentaAcudienteView`, modo «pública»): una sola presentación para la
 * familia, la escuela y este enlace.
 *
 * Lo que NO muestra (lo decide el servidor, ver estado-cuenta-enlace.contenido.ts):
 * nombre completo del deportista, correo, teléfono, documento, imágenes de
 * comprobantes, ni la fecha de cada clase. El token es la única credencial: quien
 * lo reciba puede abrirlo, por eso la página dice que es personal y cuándo vence.
 *
 * «Pagar» abre el enlace de cobro que ya existe (/p/<token> del cobro abierto más
 * viejo); esta página no cobra nada. «Guardar como PDF» es imprimir del navegador.
 * Mobile first: se abre desde el correo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Printer, RefreshCw } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { BFFError } from '@/lib/api/bffClient';
import { obtenerEstadoCuentaPublico, type VistaEstadoCuentaPublica } from '@/lib/api/estadoCuentaEnlace';
import { EstadoCuentaAcudienteView } from '@/components/account-statement/EstadoCuentaAcudiente';
import type { CobroCuenta } from '@/components/account-statement/estadoCuentaModel';
import { textoSobre } from '@/lib/colorContraste';

type Carga =
  | { tipo: 'cargando' }
  | { tipo: 'invalido' }
  | { tipo: 'vencido' }
  | { tipo: 'error' }
  | { tipo: 'ok'; vista: VistaEstadoCuentaPublica };

const fechaLarga = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

export default function EstadoCuentaPublicoPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });

  const cargar = useCallback(async () => {
    setCarga({ tipo: 'cargando' });
    try {
      setCarga({ tipo: 'ok', vista: await obtenerEstadoCuentaPublico(token) });
    } catch (e) {
      if (e instanceof BFFError && e.status === 404) setCarga({ tipo: 'invalido' });
      else if (e instanceof BFFError && e.status === 410) setCarga({ tipo: 'vencido' });
      else setCarga({ tipo: 'error' });
    }
  }, [token]);

  useEffect(() => { void cargar(); }, [cargar]);

  // El enlace es privado: que ningún buscador lo indexe.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    if (carga.tipo === 'ok') document.title = `Estado de cuenta — ${carga.vista.escuela.nombre}`;
  }, [carga]);

  return (
    <main className="min-h-screen bg-background pb-nav-safe">
      {carga.tipo === 'ok' ? <Contenido vista={carga.vista} /> : <Aviso carga={carga} onReintentar={() => void cargar()} />}
    </main>
  );
}

function Aviso({ carga, onReintentar }: { carga: Exclude<Carga, { tipo: 'ok' }>; onReintentar: () => void }) {
  if (carga.tipo === 'cargando') {
    return (
      <div className="mx-auto flex w-full max-w-page-narrow items-center justify-center gap-2 px-4 py-24 text-muted-foreground" aria-busy="true">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        Cargando el estado de cuenta…
      </div>
    );
  }
  const textos = {
    invalido: { titulo: 'Este enlace no es válido', detalle: 'Revisa que hayas abierto el enlace completo del correo. Si el problema sigue, pídele a la escuela que te lo envíe otra vez.' },
    vencido: { titulo: 'Este enlace ya no está disponible', detalle: 'Venció o la escuela lo cambió. Pídele a la escuela que te envíe uno nuevo.' },
    error: { titulo: 'No pudimos cargar tu estado de cuenta', detalle: 'Esto no quiere decir que estés al día. Revisa tu conexión e inténtalo de nuevo.' },
  }[carga.tipo];
  return (
    <div className="mx-auto w-full max-w-page-narrow px-4 py-16">
      <div role="alert" className="space-y-3 rounded-2xl border bg-card p-5">
        <p className="flex items-center gap-2 text-lg font-semibold">
          <AlertCircle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {textos.titulo}
        </p>
        <p className="text-sm text-muted-foreground">{textos.detalle}</p>
        {carga.tipo === 'error' && (
          <Button variant="outline" className="min-h-touch rounded-xl" onClick={onReintentar}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        )}
      </div>
    </div>
  );
}

function Contenido({ vista }: { vista: VistaEstadoCuentaPublica }) {
  const { escuela } = vista;
  const color = /^#[0-9a-f]{6}$/i.test(escuela.colorPrimario) ? escuela.colorPrimario : '#248223';
  const colorTexto = useMemo(() => textoSobre(color), [color]);
  const debeAlgo = vista.atletas.some((a) => a.resumen.total_open > 0);

  return (
    <>
      <header style={{ backgroundColor: color, color: colorTexto }} className="px-4 py-5 print:py-3">
        <div className="mx-auto flex w-full max-w-page-narrow items-center gap-3">
          {escuela.logoUrl && (
            <img src={escuela.logoUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg bg-black/20 object-contain" />
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-bold leading-tight">{escuela.nombre}</p>
            <p className="text-sm opacity-90">Estado de cuenta · {fechaLarga(vista.periodo.hasta)}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-page-narrow space-y-8 px-4 py-6">
        {vista.pagarUrl && debeAlgo && (
          <Button asChild className="h-14 w-full rounded-2xl text-lg font-semibold print:hidden">
            <a href={vista.pagarUrl}>Pagar lo que está pendiente</a>
          </Button>
        )}

        {vista.atletas.map((a, i) => (
          <section key={`${a.nombre}-${i}`} aria-label={`Estado de cuenta de ${a.nombre}`} className="break-inside-avoid-page">
            <EstadoCuentaAcudienteView
              state="ready"
              modo="publica"
              statement={{ athlete_name: a.nombre, summary: a.resumen, meses: [], events: [] }}
              cobros={a.cobros as CobroCuenta[]}
              months={vista.periodo.meses}
              asistencia={a.asistencia}
              onRetry={() => undefined}
              onPrint={() => window.print()}
            />
          </section>
        ))}

        <footer className="space-y-2 border-t pt-4 text-center text-xs text-muted-foreground">
          <p>Este enlace es personal: no lo reenvíes. Funciona hasta el {fechaLarga(vista.enlaceVenceEn)}.</p>
          <p className="print:hidden">
            <Printer className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            Para guardarlo como PDF usa «Imprimir» y elige «Guardar como PDF».
          </p>
          {escuela.mostrarMarcaSportmaps && <p>Powered by SportMaps</p>}
        </footer>
      </div>
    </>
  );
}
