/**
 * Verificación pública de una constancia (sin sesión). El QR del PDF trae el
 * token (nombre completo); un folio digitado muestra el nombre parcial
 * («Sofía H.») para que no se puedan recorrer los folios y sacar nombres de
 * menores. Lo que no está emitido no existe para el público.
 */
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, Loader2, Search, ShieldCheck, ShieldX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { etiquetaTipo, parametroVerificacion } from '@/lib/constancias';

type Verify = {
  found: boolean;
  via?: 'token' | 'folio';
  name_masked?: boolean;
  folio?: string;
  kind?: string;
  title?: string;
  status?: 'issued' | 'revoked';
  school_name?: string;
  athlete_name?: string;
  issued_at?: string | null;
  revoked_at?: string | null;
  revocation_reason?: string | null;
};

const fechaLarga = (d?: string | null) => (d ? new Date(d).toLocaleDateString('es-CO', { dateStyle: 'long' }) : '—');

export default function CertificateVerifyPublicPage() {
  const { folio: param } = useParams<{ folio: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Verify | null>(null);
  const [loading, setLoading] = useState(true);
  const [otro, setOtro] = useState('');

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      const args = parametroVerificacion(param);
      if (!args.p_folio && !args.p_qr_token) {
        setData({ found: false });
        setLoading(false);
        return;
      }
      const { data: r, error } = await supabase.rpc('verify_athlete_certificate_public' as any, args);
      if (cancel) return;
      setData(error || !r ? { found: false } : (r as Verify));
      setLoading(false);
    })();
    return () => { cancel = true; };
  }, [param]);

  function verificarOtro(e: FormEvent) {
    e.preventDefault();
    const v = otro.trim();
    if (v) navigate(`/cert/${encodeURIComponent(v.toUpperCase())}`);
  }

  const buscador = (
    <form onSubmit={verificarOtro} className="flex gap-2 pt-4 border-t">
      <Input value={otro} onChange={(e) => setOtro(e.target.value)} placeholder="Ej.: CDB-2026-00001" aria-label="Folio a verificar" />
      <Button type="submit" variant="outline" className="gap-1 shrink-0"><Search className="h-4 w-4" />Verificar</Button>
    </form>
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!data || !data.found) {
    const esFolio = !!parametroVerificacion(param).p_folio;
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 text-center space-y-3">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto" />
            <h1 className="text-xl font-bold text-gray-800">Constancia no encontrada</h1>
            <p className="text-sm text-muted-foreground">
              {esFolio
                ? `No hay una constancia emitida con el folio ${parametroVerificacion(param).p_folio}. Revisa que esté bien escrito.`
                : 'El código no corresponde a una constancia emitida.'}
            </p>
            {buscador}
          </CardContent>
        </Card>
      </div>
    );
  }

  const valida = data.status === 'issued';

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardContent className="pt-8 text-center space-y-4">
          {valida ? (
            <div className="flex flex-col items-center gap-2 text-green-700">
              <ShieldCheck className="h-14 w-14" />
              <h1 className="text-2xl font-bold">Constancia válida</h1>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-red-700">
              <ShieldX className="h-14 w-14" />
              <h1 className="text-2xl font-bold">Constancia anulada</h1>
              <p className="text-sm text-red-800">La escuela la anuló: este documento ya no es válido.</p>
            </div>
          )}

          <div className="border-t pt-4 space-y-2 text-left">
            <Row label="Folio" value={data.folio} />
            <Row label="Documento" value={data.title} />
            <Row label="Tipo" value={etiquetaTipo(data.kind)} />
            <Row label="Deportista" value={data.athlete_name} />
            <Row label="Escuela" value={data.school_name} />
            <Row label="Expedida" value={fechaLarga(data.issued_at)} />
            {data.revoked_at && <Row label="Anulada" value={fechaLarga(data.revoked_at)} />}
            {data.revocation_reason && <Row label="Motivo" value={data.revocation_reason} />}
          </div>

          {data.name_masked && (
            <p className="text-xs text-muted-foreground text-left">
              Por privacidad, al verificar con el folio solo se muestra el primer nombre y las iniciales.
              El código QR del documento muestra el nombre completo.
            </p>
          )}

          <p className="text-xs text-muted-foreground pt-3 border-t">Verificación oficial · SportMaps</p>
          {buscador}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value || '—'}</span>
    </div>
  );
}
