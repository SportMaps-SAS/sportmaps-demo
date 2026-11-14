import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Copy, MessageCircle } from 'lucide-react';
import type { TeamDto } from '@/lib/tournamentTypes';
import { LIVE_BASE } from './FixtureGeneratorDialog';

export type InviteStage = 'enviado' | 'abierto' | 'nomina' | 'pago' | 'listo' | 'revocado' | 'vencido';
export interface InviteDto {
  id: string; team_id: string; delegate_name: string | null; delegate_phone: string | null; delegate_email: string | null;
  expires_at: string | null; opened_at: string | null; roster_target: number | null; roster_submitted_at: string | null;
  rules_accepted_at: string | null; consent_at: string | null; payment_status: 'not_required' | 'pending' | 'proof_sent' | 'paid';
  payment_amount: number | null; has_payment_proof: boolean; completed_at: string | null; wants_sportmaps: boolean;
  stage: InviteStage; players: number | null;
}

export const STAGE_LABEL: Record<InviteStage, string> = {
  enviado: 'Link enviado', abierto: 'Abierto', nomina: 'Nómina en curso', pago: 'Falta el pago', listo: 'Listo', revocado: 'Link desactivado', vencido: 'Link vencido',
};

/** Crear (o volver a generar) el link de inscripción de un equipo externo y mandarlo por WhatsApp. */
export function TeamInviteDialog({ eventId, team, current, onClose, onCreated }: {
  eventId: string; team: TeamDto | null; current?: InviteDto | null; onClose: () => void; onCreated: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; whatsapp_url: string | null } | null>(null);

  useEffect(() => {
    if (!team) return;
    setName(current?.delegate_name ?? ''); setPhone(current?.delegate_phone ?? ''); setEmail(current?.delegate_email ?? '');
    setTarget(current?.roster_target ? String(current.roster_target) : ''); setAmount(current?.payment_amount ? String(current.payment_amount) : '');
    setExpires(''); setResult(null);
  }, [team, current]);

  const create = async () => {
    if (!team) return;
    if (!phone.trim() && !email.trim()) { toast({ title: 'Escribe el celular o el correo del delegado', variant: 'destructive' }); return; }
    setBusy(true);
    try {
      const r = await bffClient.post<{ url: string; whatsapp_url: string | null }>(`${LIVE_BASE}/school/${eventId}/teams/${team.id}/invite`, {
        delegate_name: name.trim() || null, delegate_phone: phone.trim() || null, delegate_email: email.trim() || null,
        roster_target: target ? Number(target) : null, payment_amount: amount ? Number(amount) : null,
        expires_at: expires ? `${expires}T23:59:59-05:00` : null,
      });
      setResult(r); onCreated();
    } catch (e) { toast({ title: 'No se pudo crear el link', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(result!.url); toast({ title: 'Link copiado' }); }
    catch { toast({ title: 'No se pudo copiar', description: 'Selecciona el link y cópialo a mano.', variant: 'destructive' }); }
  };

  return (
    <Dialog open={!!team} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link de inscripción · {team?.name}</DialogTitle>
          <DialogDescription>El delegado lo abre sin crear cuenta: sube el logo, la nómina y, si cobras, el comprobante.</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3" data-testid="invite-result">
            <p className="text-sm font-medium">Comparte este link ahora: no volverá a mostrarse.</p>
            <div className="flex gap-2">
              <Input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} aria-label="Link de inscripción" />
              <Button variant="outline" onClick={copy} aria-label="Copiar link"><Copy className="h-4 w-4" /></Button>
            </div>
            {result.whatsapp_url && (
              <Button asChild className="w-full"><a href={result.whatsapp_url} target="_blank" rel="noreferrer"><MessageCircle className="mr-1 h-4 w-4" /> Enviar por WhatsApp</a></Button>
            )}
            <div className="flex justify-center"><div className="rounded bg-white p-2"><QRCodeSVG value={result.url} size={160} level="M" /></div></div>
          </div>
        ) : (
          <div className="space-y-3">
            {current && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">Este equipo ya tiene un link. Generar uno nuevo desactiva el anterior.</p>}
            <div className="space-y-1.5"><Label htmlFor="inv-name">Nombre del delegado</Label><Input id="inv-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="inv-phone">Celular (WhatsApp)</Label><Input id="inv-phone" inputMode="tel" maxLength={30} placeholder="300 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="inv-email">Correo</Label><Input id="inv-email" type="email" maxLength={160} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="inv-target">Jugadores esperados</Label><Input id="inv-target" type="number" min={1} max={200} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="12" /></div>
              <div className="space-y-1.5"><Label htmlFor="inv-amount">Valor de la inscripción (COP)</Label><Input id="inv-amount" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0 = gratis" /></div>
            </div>
            <div className="space-y-1.5"><Label htmlFor="inv-exp">Vence (opcional)</Label><Input id="inv-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{result ? 'Listo' : 'Cancelar'}</Button>
          {!result && <Button onClick={create} disabled={busy}>{busy ? 'Creando…' : 'Crear link'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
