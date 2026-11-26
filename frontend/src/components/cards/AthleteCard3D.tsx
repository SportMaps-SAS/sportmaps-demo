/**
 * Carnet 3D del deportista (spec docs/specs/carnet-3d-club.md §4, F3/F4).
 *
 * Proporción ID-1 vertical, base 340 × 540 px (la misma del carnet clásico, para
 * reusar la exportación) y escalable con `ancho`.
 *
 * - Frente: logo SportMaps, escudo del club (o escudoPorDefecto), escudo como
 *   marca de agua detrás del número grande en contorno, foto o iniciales en
 *   círculo, nombre, posición en el color de acento, club, categoría y código.
 *   Fondo tipo uniforme: franjas del principal + banda diagonal del secundario.
 * - Reverso: el componente del registro según `reverso.deporte` (si llegó),
 *   QR al token y código.
 * - NUNCA estado de pagos ni habilitación (D7).
 *
 * `modo='interactivo'`: inclinación, brillo holográfico y giro (useTilt3D).
 * `modo='plano'`: una sola cara, sin efectos ni transform 3D — es lo que se
 * captura para «Descargar imagen» (cardExport). `reversoInicial` elige la cara.
 *
 * Fondo, franjas, número y cancha son SVG (html2canvas no pinta bien los
 * gradientes repetidos ni -webkit-text-stroke).
 */
import { useMemo, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone } from 'lucide-react';
import type { AthleteCard3DProps, Carnet3DDatos } from '@/lib/cards/contratos';
import { escudoPorDefecto, textoSobre } from '@/lib/cards/clubIdentity';
import { reversoPara } from '@/lib/cards/reversos';
import { useTilt3D } from '@/hooks/useTilt3D';
import { cn } from '@/lib/utils';

export const CARNET3D_W = 340;
export const CARNET3D_H = 540;

/** «María José Pérez Gómez» → «MG». */
export function inicialesPersona(nombre: string): string {
  const p = String(nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  const a = p[0][0] ?? '';
  const b = p.length > 1 ? p[p.length - 1][0] ?? '' : '';
  return (a + b).toUpperCase() || '?';
}

/** URL del QR: la misma de siempre, /c/:token. */
export function urlVerificacion(qrToken: string): string {
  const origin = typeof window === 'undefined' ? 'https://app.sportmaps.co' : window.location.origin;
  return `${origin}/c/${qrToken}`;
}

function useEscudo(datos: Carnet3DDatos): string {
  const { identidad } = datos;
  return useMemo(
    () => identidad.escudoUrl || escudoPorDefecto(identidad),
    [identidad],
  );
}

/** Fondo tipo uniforme: principal con franjas + banda diagonal del secundario. */
function FondoUniforme({ primario, secundario, banda = true }: { primario: string; secundario: string; banda?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={CARNET3D_W}
      height={CARNET3D_H}
      viewBox={`0 0 ${CARNET3D_W} ${CARNET3D_H}`}
      style={{ position: 'absolute', inset: 0 }}
    >
      <rect width={CARNET3D_W} height={CARNET3D_H} fill={primario} />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x={i * 44 + 22} y="0" width="22" height={CARNET3D_H} fill="#000000" opacity="0.07" />
      ))}
      {banda && (
        <>
          <polygon points={`0,300 ${CARNET3D_W},210 ${CARNET3D_W},262 0,352`} fill={secundario} />
          <polygon points={`0,358 ${CARNET3D_W},268 ${CARNET3D_W},276 0,366`} fill={secundario} opacity="0.55" />
        </>
      )}
      {/* Sombra suave abajo para que el texto se lea sobre las franjas. */}
      <rect x="0" y={CARNET3D_H - 190} width={CARNET3D_W} height="190" fill="#000000" opacity="0.18" />
    </svg>
  );
}

function MarcaSportMaps({ color }: { color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <img src="/sportmaps-logo.png" alt="" width={22} height={22} style={{ width: 22, height: 22, borderRadius: 6, objectFit: 'cover', background: '#FFFFFF' }} />
      <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.3, color }}>SportMaps</span>
    </div>
  );
}

function Frente({ datos }: { datos: Carnet3DDatos }) {
  const { identidad } = datos;
  const escudo = useEscudo(datos);
  const tx = textoSobre(identidad.primario);
  const txAcento = textoSobre(identidad.acento);
  const nombreLargo = datos.nombre.length > 22;
  const numero = datos.numero != null ? String(datos.numero) : null;

  return (
    <div style={{ position: 'relative', width: CARNET3D_W, height: CARNET3D_H, overflow: 'hidden', color: tx, fontFamily: 'inherit' }}>
      <FondoUniforme primario={identidad.primario} secundario={identidad.secundario} />

      {/* Arriba: SportMaps + escudo */}
      <div style={{ position: 'absolute', top: 16, left: 18, right: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <MarcaSportMaps color={tx} />
        <img src={escudo} alt={`Escudo de ${identidad.nombre}`} width={56} height={66} style={{ width: 56, height: 66, objectFit: 'contain' }} />
      </div>

      {/* Marca de agua del escudo + número en contorno */}
      <img
        src={escudo}
        alt=""
        aria-hidden="true"
        width={230}
        height={270}
        style={{ position: 'absolute', left: 55, top: 54, width: 230, height: 270, objectFit: 'contain', opacity: 0.12 }}
      />
      {numero && (
        <svg aria-hidden="true" width={CARNET3D_W} height={190} viewBox={`0 0 ${CARNET3D_W} 190`} style={{ position: 'absolute', left: 0, top: 70 }}>
          <text
            x={CARNET3D_W / 2}
            y="160"
            textAnchor="middle"
            fontFamily="Arial Black, Arial, Helvetica, sans-serif"
            fontWeight="900"
            fontSize={numero.length > 2 ? 130 : 170}
            fill="none"
            stroke={tx}
            strokeOpacity="0.55"
            strokeWidth="3"
          >
            {numero}
          </text>
        </svg>
      )}

      {/* Foto o iniciales en círculo */}
      <div
        style={{
          position: 'absolute', left: (CARNET3D_W - 136) / 2, top: 196, width: 136, height: 136, borderRadius: '50%',
          border: `4px solid ${identidad.acento}`, background: '#FFFFFF', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {datos.fotoUrl ? (
          <img src={datos.fotoUrl} alt={`Foto de ${datos.nombre}`} width={128} height={128} style={{ width: 128, height: 128, objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 46, fontWeight: 800, color: identidad.primario }}>{inicialesPersona(datos.nombre)}</span>
        )}
      </div>

      {/* Datos */}
      <div style={{ position: 'absolute', left: 18, right: 18, top: 346, bottom: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: nombreLargo ? 20 : 24, lineHeight: nombreLargo ? '24px' : '28px', fontWeight: 800, maxHeight: nombreLargo ? 48 : 56, overflow: 'hidden', wordBreak: 'break-word' }}>
          {datos.nombre}
        </p>
        {datos.posicion && (
          <span
            style={{
              marginTop: 6, padding: '2px 12px', borderRadius: 999, background: identidad.acento, color: txAcento,
              fontSize: 12, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', maxWidth: '100%',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {datos.posicion}
          </span>
        )}
        <p style={{ margin: '8px 0 0', fontSize: 14, fontWeight: 700, lineHeight: '18px', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {identidad.nombre}
        </p>
        {datos.categoria && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: '17px', opacity: 0.9, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {datos.categoria}
          </p>
        )}
        <p style={{ margin: 'auto 0 0', fontSize: 13, fontWeight: 700, letterSpacing: 1.2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
          {datos.codigo ?? 'SM-····-·····-····'}
        </p>
      </div>
    </div>
  );
}

function Reverso({ datos }: { datos: Carnet3DDatos }) {
  const { identidad } = datos;
  const escudo = useEscudo(datos);
  const tx = textoSobre(identidad.primario);
  const back = datos.reverso?.found ? datos.reverso : null;
  const Componente = back ? reversoPara(back.deporte) : null;

  return (
    <div style={{ position: 'relative', width: CARNET3D_W, height: CARNET3D_H, overflow: 'hidden', color: tx }}>
      <FondoUniforme primario={identidad.primario} secundario={identidad.secundario} banda={false} />

      <div style={{ position: 'absolute', top: 14, left: 16, right: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src={escudo} alt="" aria-hidden="true" width={34} height={40} style={{ width: 34, height: 40, objectFit: 'contain' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 800, lineHeight: '17px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{identidad.nombre}</p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: '15px', opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{datos.nombre}</p>
        </div>
      </div>

      {back && Componente && (
        <div style={{ position: 'absolute', top: 66, left: 14, right: 14, height: 300, borderRadius: 16, background: '#FFFFFF', padding: 12, color: '#111827' }}>
          <Componente reverso={back} numero={datos.numero} posicion={datos.posicion} acento={identidad.acento} />
        </div>
      )}

      <div
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 16, top: back ? 378 : 90,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 8, lineHeight: 0 }}>
          {datos.qrToken ? (
            <QRCodeSVG value={urlVerificacion(datos.qrToken)} size={back ? 96 : 190} level="M" />
          ) : (
            <div
              aria-label="Código QR de ejemplo"
              style={{ width: back ? 96 : 190, height: back ? 96 : 190, borderRadius: 6, background: 'repeating-conic-gradient(#111827 0% 25%, #FFFFFF 0% 50%) 0 0 / 16px 16px', opacity: 0.25 }}
            />
          )}
        </div>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 1.2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
          {datos.codigo ?? 'SM-····-·····-····'}
        </p>
        <p style={{ margin: 0, fontSize: 11, opacity: 0.85 }}>Escanea el código para verificar el carnet</p>
      </div>
    </div>
  );
}

/** Capas de brillo: holográfico + reflejo. Solo transform/opacity animados. */
function Brillos() {
  return (
    <>
      <div
        data-brillo="holo"
        aria-hidden="true"
        style={{
          position: 'absolute', left: 0, top: 0, width: '200%', height: '200%', pointerEvents: 'none', opacity: 0.15,
          transform: 'translate3d(-25%, -25%, 0)', willChange: 'transform, opacity', mixBlendMode: 'overlay',
          background:
            'linear-gradient(115deg, transparent 20%, rgba(255,0,128,0.55) 30%, rgba(255,214,0,0.55) 38%, rgba(0,255,170,0.55) 46%, rgba(0,160,255,0.55) 54%, rgba(170,0,255,0.55) 62%, transparent 72%)',
        }}
      />
      <div
        data-brillo="reflejo"
        aria-hidden="true"
        style={{
          position: 'absolute', left: 0, top: 0, width: '200%', height: '200%', pointerEvents: 'none', opacity: 0.1,
          transform: 'translate3d(25%, 25%, 0)', willChange: 'transform, opacity',
          background: 'linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.45) 49%, rgba(255,255,255,0.1) 53%, transparent 60%)',
        }}
      />
    </>
  );
}

const caraBase: CSSProperties = {
  position: 'absolute', inset: 0, borderRadius: 18, overflow: 'hidden',
  backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
};

export function AthleteCard3D({ datos, modo = 'interactivo', ancho = CARNET3D_W, reversoInicial = false, className }: AthleteCard3DProps) {
  const escala = ancho / CARNET3D_W;
  const alto = Math.round(CARNET3D_H * escala);
  const plano = modo === 'plano';
  const tilt = useTilt3D({ activo: !plano, giradoInicial: reversoInicial });

  const escalar: CSSProperties = {
    width: CARNET3D_W, height: CARNET3D_H,
    transform: escala !== 1 ? `scale(${escala})` : undefined,
    transformOrigin: '0 0',
  };

  if (plano) {
    return (
      <div className={className} style={{ width: ancho, height: alto }}>
        <div style={escalar}>
          <div data-carnet3d-cara={reversoInicial ? 'reverso' : 'frente'} style={{ width: CARNET3D_W, height: CARNET3D_H, borderRadius: 18, overflow: 'hidden' }}>
            {reversoInicial ? <Reverso datos={datos} /> : <Frente datos={datos} />}
          </div>
        </div>
      </div>
    );
  }

  const { girado, reducido, animado, movimiento } = tilt;
  const etiqueta = girado ? `Reverso del carnet de ${datos.nombre}. Toca para ver el frente.` : `Carnet de ${datos.nombre}. Toca para ver el reverso.`;

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <div style={{ width: ancho, height: alto }}>
        <div style={escalar}>
          <div
            ref={tilt.refEscena}
            role="button"
            tabIndex={0}
            aria-label={etiqueta}
            aria-pressed={girado}
            {...tilt.manejadores}
            className="cursor-pointer rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-primary/50"
            style={{ width: CARNET3D_W, height: CARNET3D_H, perspective: animado ? 1100 : undefined, touchAction: 'pan-y', userSelect: 'none', WebkitTapHighlightColor: 'transparent' }}
          >
            <div
              ref={tilt.refTarjeta}
              style={{
                position: 'relative', width: CARNET3D_W, height: CARNET3D_H, borderRadius: 18,
                transformStyle: animado ? 'preserve-3d' : undefined, willChange: animado ? 'transform' : undefined,
                boxShadow: '0 18px 40px -12px rgba(0,0,0,0.45)',
              }}
            >
              {animado ? (
                <>
                  <div style={caraBase}><Frente datos={datos} /><Brillos /></div>
                  <div style={{ ...caraBase, transform: 'rotateY(180deg)' }}><Reverso datos={datos} /><Brillos /></div>
                </>
              ) : (
                // Movimiento reducido (o sin animación): el giro es un fundido.
                <>
                  <div aria-hidden={girado} style={{ ...caraBase, opacity: girado ? 0 : 1, transition: reducido ? 'opacity 220ms ease' : undefined }}>
                    <Frente datos={datos} />
                  </div>
                  <div aria-hidden={!girado} style={{ ...caraBase, opacity: girado ? 1 : 0, transition: reducido ? 'opacity 220ms ease' : undefined }}>
                    <Reverso datos={datos} />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {movimiento === 'requiere_permiso' && (
        <button
          type="button"
          onClick={() => { void tilt.activarMovimiento(); }}
          className="inline-flex min-h-touch items-center gap-2 rounded-full px-4 text-sm font-semibold text-primary hover:bg-primary/10"
        >
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          Activar movimiento
        </button>
      )}
    </div>
  );
}

/** «Datos del deportista» que la escuela encendió, fuera del carnet (D8). */
export function DatosDelDeportista({ filas, className }: { filas: Array<{ etiqueta: string; valor: string }>; className?: string }) {
  if (filas.length === 0) return null;
  return (
    <dl className={cn('w-full divide-y rounded-2xl border bg-card px-4', className)}>
      {filas.map((f) => (
        <div key={f.etiqueta} className="flex items-start justify-between gap-3 py-2.5">
          <dt className="shrink-0 text-sm text-muted-foreground">{f.etiqueta}</dt>
          <dd className="min-w-0 break-words text-right text-sm font-medium">{f.valor}</dd>
        </div>
      ))}
    </dl>
  );
}

export default AthleteCard3D;

/**
 * Deportista de ejemplo para vistas previas (admin en /cards, «Datos y marca»).
 * Sin token: el reverso muestra un QR de muestra.
 */
export function datosDeEjemplo(identidad: Carnet3DDatos['identidad']): Carnet3DDatos {
  return {
    nombre: 'Sofía Ramírez',
    fotoUrl: null,
    numero: 10,
    posicion: 'Volante',
    categoria: 'Sub-12',
    codigo: `SM-${new Date().getFullYear()}-00001-K7QP`,
    qrToken: null,
    identidad,
    reverso: {
      found: true,
      estado: 'active',
      deporte: 'futbol',
      deporte_nombre: 'Fútbol',
      zona_de_juego: { posicion: 'Volante', numero: 10, origen: 'inscripcion' },
      estadisticas: [
        { clave: 'asistencia', etiqueta: 'Asistencia', valor: '92 %', detalle: 'últimos 90 días' },
        { clave: 'sesiones', etiqueta: 'Sesiones', valor: '24', detalle: 'últimos 90 días' },
        { clave: 'ultimo_informe', etiqueta: 'Último informe', valor: 'oct 2026', detalle: null },
        { clave: 'antiguedad', etiqueta: 'En el club', valor: '1 año', detalle: null },
      ],
      origen: 'generico',
    },
  };
}
