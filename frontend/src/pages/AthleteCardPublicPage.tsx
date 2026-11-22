import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Download, AlertCircle, CheckCircle2, AlertTriangle, XCircle, LogIn, ShieldCheck, RotateCw, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { AthleteIdCard, type CardData } from '@/components/cards/AthleteIdCard';
import { useToast } from '@/hooks/use-toast';
import { exportCardPng } from '@/lib/cards/cardExport';
import { maskPrivateCardData, slugifyFileName } from '@/lib/cards/cardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { type CheckInResponse, resolveOutcomeInfo, MARKED_PRESENT } from '@/lib/attendanceCheckInOutcomes';

// Fase 4 — panel de acciones para staff (docs/specs/asistencia-rapida-checkin.md
// §3.2, decisión D2). Esta página es pública (cualquiera con el link ve el
// carnet), pero si quien la abre YA tiene sesión de staff de la MISMA escuela
// — típico: escaneó con la cámara normal del teléfono, no con el escáner
// in-app — puede marcar asistencia sin salir de acá. Si no tiene sesión, se le
// ofrece loguearse inline (D2: "sí, login inline" — costo de un botón, riesgo
// cero porque la escritura se valida en el servidor pase lo que pase acá).
const STAFF_ROLES = new Set(['owner', 'super_admin', 'admin', 'school_admin', 'coach']);

export default function AthleteCardPublicPage() {
  const { qrToken } = useParams<{ qrToken: string }>();
  const [data, setData] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [face, setFace] = useState<'front' | 'back'>('front');
  const { toast } = useToast();
  const { user, profile, loading: authLoading, signIn } = useAuth();

  const [showStaffLogin, setShowStaffLogin] = useState(false);
  const [staffEmail, setStaffEmail] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkInResult, setCheckInResult] = useState<{ athleteName: string; label: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  const isStaffRole = !!profile && STAFF_ROLES.has(profile.role);

  useEffect(() => {
    if (!qrToken) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrToken]);

  async function load() {
    setLoading(true);
    const { data: rpc, error } = await supabase.rpc(
      'verify_athlete_id_card_public' as any,
      { p_qr_token: qrToken }
    );
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setData({ found: false, status: 'error' } as CardData);
    } else {
      let card = rpc as CardData;
      // Sin sesión no se pinta nada privado aunque la RPC (versión vieja, sin
      // 'viewer') lo mande. El arreglo de fondo está en la RPC.
      if (card?.found && card.status === 'active' && card.viewer !== 'staff' && card.viewer !== 'guardian') {
        const { data: sess } = await supabase.auth.getSession();
        if (!sess.session || card.viewer === 'public') card = maskPrivateCardData(card);
      }
      setData(card);
    }
    setLoading(false);
  }

  // PNG con frente y reverso a resolución de impresión (antes: una captura de
  // pantalla de la cara visible, con el texto mochado y la foto en blanco).
  async function handleDownload() {
    if (!data || !qrToken) return;
    setDownloading(true);
    try {
      await exportCardPng(
        { data, publicUrl: window.location.href },
        `carnet-${slugifyFileName(data.athlete?.full_name, qrToken.slice(0, 8))}`,
      );
    } catch (e: any) {
      toast({ title: 'No se pudo descargar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  }

  async function handleStaffSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    try {
      await signIn(staffEmail, staffPassword);
      setStaffPassword('');
    } catch {
      // signIn ya muestra su propio toast de error
    } finally {
      setSigningIn(false);
    }
  }

  async function handleMarkAttendance() {
    if (!data?.qr_token || !data.school?.id) return;
    setCheckingIn(true);
    setCheckInResult(null);
    try {
      const result = await bffClient.post<CheckInResponse>(
        '/api/v1/attendance/checkin-by-card',
        { qrToken: data.qr_token },
        { 'x-school-id': data.school.id },
      );
      const info = resolveOutcomeInfo(result.outcome);
      setCheckInResult({ athleteName: result.athleteName || data.athlete?.full_name || 'Atleta', ...info });
    } catch (err: any) {
      const msg = err instanceof BFFError ? err.message : (err?.message || 'No se pudo marcar asistencia.');
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      setCheckingIn(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!data || !data.found) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 p-6 text-center">
        <AlertCircle className="h-12 w-12 text-red-500 mb-3" />
        <h1 className="text-xl font-bold text-gray-800 mb-1">Carnet no encontrado</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          El código escaneado no corresponde a un carnet válido. Si crees que es un error,
          contacta a tu escuela.
        </p>
      </div>
    );
  }

  const publicUrl = typeof window !== 'undefined' ? window.location.href : '';

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4 gap-6">
      <div className="text-center">
        <h1 className="text-lg font-bold text-gray-800">
          {data.status === 'active' ? 'Carnet verificado' : data.status === 'revoked' ? 'Carnet revocado' : 'Carnet vencido'}
        </h1>
        <p className="text-xs text-muted-foreground">
          {data.school?.name ? `Verificación oficial de ${data.school.name}` : "Verificación oficial SportMaps"}
        </p>
      </div>

      <AthleteIdCard data={data} publicUrl={publicUrl} face={face} />

      {data.status === 'active' && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="ghost" onClick={() => setFace((f) => (f === 'front' ? 'back' : 'front'))} className="gap-2">
            <RotateCw className="h-4 w-4" />
            {face === 'front' ? 'Ver reverso' : 'Ver frente'}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={downloading}
            variant="outline"
            className="gap-2"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Descargar PNG
          </Button>
        </div>
      )}

      {data.status === 'active' && data.viewer === 'public' && (
        <p className="max-w-sm text-center text-xs text-muted-foreground flex items-start gap-1.5">
          <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          Vista pública: solo muestra la identidad y la vigencia. Los datos médicos, de emergencia y de pagos
          los ven la escuela y el acudiente con su sesión iniciada.
        </p>
      )}

      {data.status === 'active' && data.fee_status === 'overdue' && (
        <div className="max-w-sm bg-red-50 border border-red-200 rounded-lg p-3 text-center text-sm text-red-700">
          <strong>Cuota vencida.</strong> Realiza tu próximo pago para mantener el carnet vigente.
        </div>
      )}

      {data.status === 'active' && !authLoading && (
        isStaffRole ? (
          <div className="w-full max-w-sm bg-white border rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Panel de staff
            </div>
            <Button onClick={handleMarkAttendance} disabled={checkingIn} className="w-full gap-2">
              {checkingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Marcar asistencia
            </Button>
            {checkInResult && (
              <div
                className={`rounded-lg border p-3 flex items-center gap-2 text-sm ${
                  checkInResult.tone === 'ok'
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : checkInResult.tone === 'warn'
                    ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                {checkInResult.tone === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                  : checkInResult.tone === 'warn' ? <AlertTriangle className="h-4 w-4 shrink-0" />
                  : <XCircle className="h-4 w-4 shrink-0" />}
                <div>
                  <p className="font-semibold">{checkInResult.athleteName}</p>
                  <p className="text-xs opacity-90">{checkInResult.label}</p>
                </div>
              </div>
            )}
          </div>
        ) : !user ? (
          <div className="w-full max-w-sm">
            {!showStaffLogin ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 mx-auto block"
                onClick={() => setShowStaffLogin(true)}
              >
                ¿Eres del staff de esta escuela? Iniciar sesión
              </button>
            ) : (
              <form onSubmit={handleStaffSignIn} className="bg-white border rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-1">
                  <LogIn className="h-3.5 w-3.5" /> Iniciar sesión de staff
                </p>
                <Input
                  type="email"
                  autoComplete="username"
                  placeholder="Correo"
                  value={staffEmail}
                  onChange={(e) => setStaffEmail(e.target.value)}
                  required
                />
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Contraseña"
                  value={staffPassword}
                  onChange={(e) => setStaffPassword(e.target.value)}
                  required
                />
                <Button type="submit" disabled={signingIn} className="w-full">
                  {signingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Ingresar'}
                </Button>
              </form>
            )}
          </div>
        ) : null
      )}
    </div>
  );
}
