/**
 * Cargar un documento con vigencia (carnet 3D F5): seguro deportivo, certificado médico o
 * autorización del acudiente para un evento, con su «Vence el».
 *
 * Sube por el BFF (`POST /api/v1/soportes/...`, bucket privado): puede la administración de la
 * escuela o la propia familia (el coach no). Solo vigencia, NUNCA diagnósticos.
 */
import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  aceptaArchivo, leerBase64, mensajeErrorSoporte, soportesApi, validarArchivoSoporte,
  type TipoSujetoSoporte,
} from '@/lib/api/soportes';
import {
  DOCUMENTOS_VIGENCIA, hoyBogota, validarVigencia,
  type EventoHabilitacion, type TipoDocumentoVigencia,
} from '@/lib/cards/habilitacion';

interface Props {
  schoolId: string;
  sujeto: { tipo: TipoSujetoSoporte; id: string };
  /** Eventos para la autorización; sin eventos no se ofrece ese tipo. */
  eventos: EventoHabilitacion[];
  /** Evento elegido en el panel (se propone para la autorización). */
  eventoActualId?: string | null;
  onSubido?: () => void;
}

const selectClase = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

export function CargarDocumentoVigencia({ schoolId, sujeto, eventos, eventoActualId, onSubido }: Props) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const tipos = DOCUMENTOS_VIGENCIA.filter((d) => d.tipo !== 'event_authorization' || eventos.length > 0);
  const [tipo, setTipo] = useState<TipoDocumentoVigencia>(tipos[0]?.tipo ?? 'sports_insurance');
  const [venceEl, setVenceEl] = useState('');
  const [eventId, setEventId] = useState<string>(eventoActualId ?? '');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const hoy = hoyBogota();

  async function subir() {
    const errVig = validarVigencia(tipo, venceEl, tipo === 'event_authorization' ? eventId : null, hoy);
    if (errVig) { setError(errVig); return; }
    if (!archivo) { setError('Elige el archivo (foto o PDF).'); return; }
    const errArchivo = validarArchivoSoporte(tipo, archivo);
    if (errArchivo) { setError(errArchivo); return; }
    setError(null);
    setSubiendo(true);
    try {
      const base64 = await leerBase64(archivo);
      await soportesApi.subir(schoolId, sujeto.tipo, sujeto.id, tipo, base64, archivo.name, {
        vence_el: venceEl || null,
        event_id: tipo === 'event_authorization' ? eventId : null,
      });
      toast({ title: 'Documento guardado', description: 'El estado se actualizó.' });
      setArchivo(null);
      setVenceEl('');
      if (inputRef.current) inputRef.current.value = '';
      onSubido?.();
    } catch (e) {
      setError(mensajeErrorSoporte(e));
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="cargar-documento-vigencia">
      <div className="space-y-1.5">
        <Label htmlFor="doc-vig-tipo">Documento</Label>
        <select
          id="doc-vig-tipo"
          className={selectClase}
          value={tipo}
          onChange={(e) => { setTipo(e.target.value as TipoDocumentoVigencia); setError(null); }}
        >
          {tipos.map((d) => <option key={d.tipo} value={d.tipo}>{d.etiqueta}</option>)}
        </select>
      </div>

      {tipo === 'event_authorization' && (
        <div className="space-y-1.5">
          <Label htmlFor="doc-vig-evento">Evento</Label>
          <select id="doc-vig-evento" className={selectClase} value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Elige el evento</option>
            {eventos.map((ev) => <option key={ev.id} value={ev.id}>{ev.titulo}</option>)}
          </select>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="doc-vig-vence">
          Vence el{tipo === 'event_authorization' ? ' (opcional)' : ''}
        </Label>
        <Input id="doc-vig-vence" type="date" min={hoy} value={venceEl} onChange={(e) => setVenceEl(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="doc-vig-archivo">Archivo (foto o PDF, hasta 4 MB)</Label>
        <Input
          id="doc-vig-archivo"
          ref={inputRef}
          type="file"
          accept={aceptaArchivo(tipo)}
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
        />
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <Button onClick={subir} disabled={subiendo} className="w-full gap-2">
        {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Guardar documento
      </Button>
      <p className="text-xs text-muted-foreground">Solo se guarda hasta cuándo es válido. Nunca se piden diagnósticos.</p>
    </div>
  );
}
