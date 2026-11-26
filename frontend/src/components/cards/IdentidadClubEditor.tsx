/**
 * Editor «Identidad del club» (carnet 3D, F2 — spec docs/specs/carnet-3d-club.md §6).
 *
 * Lo usan BrandingSettingsForm (Configuración) e IdentidadClubDialog.
 * - Tres colores (principal, secundario, acento) + «Restablecer» (diseño base).
 * - Escudo PNG/WebP/SVG con confirmación de derechos; sube por POST /api/v1/branding/escudo.
 * - Aviso de contraste del acento y vista previa en vivo.
 * - Sin complemento (D3): prueba colores y escudo SOLO en la vista previa
 *   (nada se sube ni se guarda) y ve el llamado a activar el complemento.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Palette, RotateCcw, Save, Shield, Upload, Lock, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  SPORTMAPS_BASE,
  esHex,
  resolverIdentidad,
  avisoContrasteAcento,
  textoSobre,
  escudoPorDefecto,
  type BrandingSettingsCarnet,
  type ClubIdentidad,
} from '@/lib/cards/clubIdentity';
import {
  ESCUDO_ACCEPT,
  revisarArchivoEscudo,
  revisarMedidasEscudo,
  mensajeDeErrorIdentidad,
  archivoABase64,
  medirImagen,
} from '@/lib/cards/identidadEditor';

const CSRF_HEADERS = { 'X-Requested-With': 'SportMaps' };

export interface IdentidadClubEditorProps {
  schoolId: string;
  /** Tras guardar colores, restablecer o subir el escudo. */
  onGuardado?: () => void;
  /** Vista previa en vivo (el carnet 3D, F3). Sin ella: mini vista previa plana. */
  renderVistaPrevia?: (identidad: ClubIdentidad) => ReactNode;
  /** Diseño en una sola columna (para la ventana en celular). */
  compacto?: boolean;
}

interface EscuelaIdentidad {
  name: string;
  logo_url: string | null;
  branding_settings: BrandingSettingsCarnet | null;
}

interface RespuestaBranding {
  ok: boolean;
  logo_url?: string | null;
  branding_settings?: BrandingSettingsCarnet;
  aviso?: string | null;
  error?: string;
  message?: string;
}

/** Datos de la escuela: del contexto si es la activa; si no, de la base. */
function useEscuelaIdentidad(schoolId: string) {
  const { schoolId: activa, schoolName, schoolBranding, refreshSchoolBranding } = useSchoolContext();
  const esActiva = activa === schoolId;
  const query = useQuery({
    queryKey: ['identidad-club', schoolId],
    enabled: !esActiva && !!schoolId,
    queryFn: async (): Promise<EscuelaIdentidad | null> => {
      const { data, error } = await supabase
        .from('schools')
        .select('name, logo_url, branding_settings')
        .eq('id', schoolId)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as EscuelaIdentidad) ?? null;
    },
  });

  // Memo: un objeto nuevo en cada render re-sincronizaría los colores y
  // borraría lo que el admin está probando.
  const escuela = useMemo<EscuelaIdentidad | null>(
    () =>
      esActiva
        ? {
            name: schoolName,
            logo_url: schoolBranding?.logo_url ?? null,
            // El contexto tipa solo 3 campos, pero trae el jsonb completo (acento, derechos).
            branding_settings: (schoolBranding?.branding_settings as BrandingSettingsCarnet | null) ?? null,
          }
        : query.data ?? null,
    [esActiva, schoolName, schoolBranding, query.data],
  );

  const refrescar = async () => {
    if (esActiva) await refreshSchoolBranding();
    else await query.refetch();
  };

  return { escuela, cargando: esActiva ? false : query.isLoading, refrescar };
}

export function IdentidadClubEditor({ schoolId, onGuardado, renderVistaPrevia, compacto }: IdentidadClubEditorProps) {
  const { toast } = useToast();
  // Colores y escudo del carnet: gratis para todas las escuelas (2026-11-26).
  const tieneComplemento = true;
  const { escuela, cargando, refrescar } = useEscuelaIdentidad(schoolId);

  // Valores guardados (con marca forzada: lo que el club tiene configurado).
  const guardada = useMemo(
    () => (escuela ? resolverIdentidad(escuela, true) : null),
    [escuela],
  );

  const [primario, setPrimario] = useState<string>(SPORTMAPS_BASE.primario);
  const [secundario, setSecundario] = useState<string>(SPORTMAPS_BASE.secundario);
  const [acento, setAcento] = useState<string>(SPORTMAPS_BASE.acento);
  const [guardando, setGuardando] = useState(false);
  const [confirmarReset, setConfirmarReset] = useState(false);

  // Escudo elegido (aún sin subir): archivo + object URL para la vista previa.
  const [archivo, setArchivo] = useState<File | null>(null);
  const [previaLocal, setPreviaLocal] = useState<string | null>(null);
  const [confirmoDerechos, setConfirmoDerechos] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [avisoEscudo, setAvisoEscudo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sincroniza con lo guardado cuando llega o cambia.
  useEffect(() => {
    if (!guardada) return;
    setPrimario(guardada.primario);
    setSecundario(guardada.secundario);
    setAcento(guardada.acento);
  }, [guardada]);

  // Libera el object URL al cambiarlo o desmontar.
  useEffect(() => {
    return () => {
      if (previaLocal) URL.revokeObjectURL(previaLocal);
    };
  }, [previaLocal]);

  const coloresValidos = esHex(primario) && esHex(secundario) && esHex(acento);
  const cambioColores =
    !!guardada && (primario !== guardada.primario || secundario !== guardada.secundario || acento !== guardada.acento);
  const aviso = coloresValidos ? avisoContrasteAcento(primario, acento) : null;
  const sugerido = textoSobre(primario);

  const identidadPrevia: ClubIdentidad = {
    nombre: escuela?.name ?? 'Tu club',
    primario: esHex(primario) ? primario : SPORTMAPS_BASE.primario,
    secundario: esHex(secundario) ? secundario : SPORTMAPS_BASE.secundario,
    acento: esHex(acento) ? acento : SPORTMAPS_BASE.acento,
    escudoUrl: previaLocal ?? guardada?.escudoUrl ?? null,
    conMarca: true,
  };

  const terminar = async (titulo: string, descripcion?: string) => {
    await refrescar();
    onGuardado?.();
    toast({ title: titulo, description: descripcion });
  };

  const fallar = (err: unknown) => {
    toast({ title: 'No se guardó', description: mensajeDeErrorIdentidad(err), variant: 'destructive' });
  };

  const guardarColores = async () => {
    if (!coloresValidos) return;
    setGuardando(true);
    try {
      await bffClient.put<RespuestaBranding>(
        `/api/v1/schools/${schoolId}/branding`,
        { primary_color: primario, secondary_color: secundario, accent_color: acento },
        CSRF_HEADERS,
      );
      await terminar('Colores guardados', 'Así se verán en el carnet y en la app.');
    } catch (err) {
      fallar(err);
    } finally {
      setGuardando(false);
    }
  };

  const restablecer = async () => {
    setConfirmarReset(false);
    setPrimario(SPORTMAPS_BASE.primario);
    setSecundario(SPORTMAPS_BASE.secundario);
    setAcento(SPORTMAPS_BASE.acento);
    if (!tieneComplemento) return; // solo vista previa
    setGuardando(true);
    try {
      await bffClient.put<RespuestaBranding>(
        `/api/v1/schools/${schoolId}/branding`,
        { reset_colores: true },
        CSRF_HEADERS,
      );
      await terminar('Listo', 'Volviste al diseño de SportMaps.');
    } catch (err) {
      fallar(err);
    } finally {
      setGuardando(false);
    }
  };

  const limpiarEscudoElegido = () => {
    setArchivo(null);
    setPreviaLocal(null);
    setConfirmoDerechos(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const elegirEscudo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvisoEscudo(null);
    const problema = revisarArchivoEscudo(f);
    if (problema) {
      toast({ title: 'Ese archivo no sirve', description: problema, variant: 'destructive' });
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    const url = URL.createObjectURL(f);
    if (f.type !== 'image/svg+xml') {
      try {
        const { ancho, alto } = await medirImagen(url);
        const p = revisarMedidasEscudo(ancho, alto);
        if (p) {
          URL.revokeObjectURL(url);
          toast({ title: 'Ese archivo no sirve', description: p, variant: 'destructive' });
          if (inputRef.current) inputRef.current.value = '';
          return;
        }
      } catch {
        URL.revokeObjectURL(url);
        toast({ title: 'Ese archivo no sirve', description: 'No pudimos abrir la imagen.', variant: 'destructive' });
        return;
      }
    }
    setArchivo(f);
    setPreviaLocal(url);
    setConfirmoDerechos(false);
  };

  const subirEscudo = async () => {
    if (!archivo || !confirmoDerechos || !tieneComplemento) return;
    setSubiendo(true);
    try {
      const archivo_base64 = await archivoABase64(archivo);
      const res = await bffClient.post<RespuestaBranding>(
        '/api/v1/branding/escudo',
        { school_id: schoolId, confirmo_derechos: true, archivo_base64 },
        CSRF_HEADERS,
      );
      limpiarEscudoElegido();
      setAvisoEscudo(res.aviso ?? null);
      await terminar('Escudo guardado', res.aviso ?? 'Ya sale en el carnet del club.');
    } catch (err) {
      fallar(err);
    } finally {
      setSubiendo(false);
    }
  };

  if (cargando) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const vistaPrevia = renderVistaPrevia ? renderVistaPrevia(identidadPrevia) : <VistaPreviaPlana identidad={identidadPrevia} />;

  return (
    <div className={compacto ? 'space-y-5' : 'grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]'}>
      <div className="space-y-6 min-w-0">
        {!tieneComplemento && <LlamadoComplemento />}

        {/* ── Colores ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Palette className="h-4 w-4 text-primary" />
            Colores del club
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <SelectorColor id="color-principal" etiqueta="Principal" valor={primario} onCambio={setPrimario} />
            <SelectorColor id="color-secundario" etiqueta="Secundario" valor={secundario} onCambio={setSecundario} />
            <SelectorColor id="color-acento" etiqueta="Acento" valor={acento} onCambio={setAcento} />
          </div>

          {aviso && (
            <div role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-2">
                <p>{aviso}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setAcento(sugerido)} className="h-7 gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: sugerido }} />
                  Usar {sugerido === '#FFFFFF' ? 'blanco' : 'casi negro'}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmarReset(true)} disabled={guardando}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Restablecer
            </Button>
            {tieneComplemento && (
              <Button type="button" size="sm" onClick={guardarColores} disabled={guardando || !coloresValidos || !cambioColores} className="gap-2">
                {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Guardar colores
              </Button>
            )}
          </div>
        </section>

        {/* ── Escudo ──────────────────────────────────────────────── */}
        <section className="space-y-3 border-t pt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Shield className="h-4 w-4 text-primary" />
            Escudo
          </h3>
          <p className="text-xs text-muted-foreground">
            PNG, WebP o SVG. Máximo 2 MB y al menos 512 px por lado. Mejor con fondo transparente.
          </p>
          <input ref={inputRef} type="file" accept={ESCUDO_ACCEPT} className="hidden" onChange={elegirEscudo} />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={subiendo}>
              <Upload className="mr-2 h-4 w-4" />
              {archivo ? 'Elegir otro' : 'Elegir escudo'}
            </Button>
            {archivo && (
              <Button type="button" variant="ghost" size="sm" onClick={limpiarEscudoElegido} disabled={subiendo}>
                Quitar
              </Button>
            )}
          </div>

          {archivo && tieneComplemento && (
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={confirmoDerechos}
                  onCheckedChange={(v) => setConfirmoDerechos(v === true)}
                  className="mt-0.5"
                  aria-label="Confirmo que el club tiene derecho a usar este escudo"
                />
                <span>Confirmo que el club tiene derecho a usar este escudo</span>
              </label>
              <Button type="button" size="sm" onClick={subirEscudo} disabled={!confirmoDerechos || subiendo} className="gap-2">
                {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {subiendo ? 'Subiendo…' : 'Subir escudo'}
              </Button>
            </div>
          )}

          {archivo && !tieneComplemento && (
            <p className="text-xs text-muted-foreground">Lo ves en la vista previa. Para usarlo en el carnet, activa el complemento.</p>
          )}

          {avisoEscudo && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{avisoEscudo}</p>
          )}
        </section>
      </div>

      {/* ── Vista previa ─────────────────────────────────────────── */}
      <aside className={compacto ? 'flex flex-col items-center gap-2 border-t pt-5' : 'flex flex-col items-center gap-2'}>
        <p className="text-xs font-medium text-muted-foreground">Vista previa</p>
        {vistaPrevia}
        {!tieneComplemento && <p className="text-center text-xs text-muted-foreground">Así quedaría con tu identidad.</p>}
      </aside>

      <AlertDialog open={confirmarReset} onOpenChange={setConfirmarReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Volver al diseño de SportMaps?</AlertDialogTitle>
            <AlertDialogDescription>
              {tieneComplemento
                ? 'Se quitan los tres colores del club. El escudo se queda.'
                : 'La vista previa vuelve a los colores de SportMaps.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={restablecer}>Restablecer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SelectorColor({ id, etiqueta, valor, onCambio }: { id: string; etiqueta: string; valor: string; onCambio: (v: string) => void }) {
  return (
    <div className="space-y-1.5 min-w-0">
      <Label htmlFor={id} className="text-xs">{etiqueta}</Label>
      <Input
        id={id}
        type="color"
        value={esHex(valor) ? valor : '#000000'}
        onChange={(e) => onCambio(e.target.value.toUpperCase())}
        className="h-11 w-full cursor-pointer p-1"
      />
      <p className="truncate text-center font-mono text-[11px] text-muted-foreground">{valor.toUpperCase()}</p>
    </div>
  );
}

/** Llamado a activar el complemento (mismo destino que el aviso de siempre: /mi-plan). */
function LlamadoComplemento() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Tus colores y tu escudo, en el carnet</p>
          <p className="text-xs text-muted-foreground">
            Pruébalos aquí. Para guardarlos, activa el complemento de marca.
          </p>
        </div>
      </div>
      <Button asChild size="sm" className="shrink-0 gap-2">
        <a href="/mi-plan">
          <Palette className="h-4 w-4" />
          Ver planes
        </a>
      </Button>
    </div>
  );
}

/**
 * Vista previa plana (respaldo mientras no llegue el carnet 3D): franjas del
 * principal, banda diagonal del secundario, escudo, nombre y posición en acento.
 */
export function VistaPreviaPlana({ identidad, ancho = 200 }: { identidad: ClubIdentidad; ancho?: number }) {
  const alto = Math.round((ancho * 540) / 340);
  const texto = textoSobre(identidad.primario);
  const escudo = identidad.escudoUrl ?? escudoPorDefecto(identidad);
  return (
    <div
      aria-label="Vista previa del carnet"
      className="relative overflow-hidden rounded-xl shadow-md"
      style={{
        width: ancho,
        height: alto,
        backgroundColor: identidad.primario,
        backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 14px, rgba(0,0,0,0.06) 14px 28px)`,
        color: texto,
      }}
    >
      <div
        className="absolute"
        style={{
          left: '-30%',
          top: '52%',
          width: '160%',
          height: '16%',
          backgroundColor: identidad.secundario,
          transform: 'rotate(-18deg)',
        }}
      />
      <div className="relative flex h-full flex-col items-center px-3 pt-4 text-center">
        <img src={escudo} alt="" className="h-14 w-14 object-contain" />
        <span className="mt-2 text-4xl font-black leading-none" style={{ WebkitTextStroke: `1.5px ${texto}`, color: 'transparent' }}>
          10
        </span>
        <div className="mt-auto mb-4 space-y-0.5">
          <p className="text-sm font-bold leading-tight">Nombre Apellido</p>
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: identidad.acento }}>
            Delantero
          </p>
          <p className="text-[11px] opacity-90 line-clamp-1">{identidad.nombre}</p>
        </div>
      </div>
    </div>
  );
}
