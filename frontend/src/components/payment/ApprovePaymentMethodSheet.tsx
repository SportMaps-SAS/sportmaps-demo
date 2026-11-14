import { useState, useEffect } from 'react';
import { approvePayment, notifyGroupApproved } from '@/lib/approvePayment';
import { orderReceiptGroup, remainingOf, dueOf, joinSpanish } from '@/lib/receiptReview';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { CheckCircle2, Loader2, AlertTriangle, ScanLine, FileText, Layers } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { getSignedReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { supabase } from '@/integrations/supabase/client';

interface ApprovePaymentMethodSheetProps {
  payment: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Lo que la familia escribió con la foto por WhatsApp, si hay. */
  familyNote?: string | null;
  /**
   * Otros cobros por aprobar con el MISMO comprobante (receipt_url). El bot los
   * liga así cuando una transferencia paga varios meses: la hoja los muestra y
   * los aprueba juntos.
   */
  siblings?: any[];
}

/** «Septiembre 2026» si es mensualidad con mes; si no, el concepto. */
const itemLabel = (p: any): string => p?.period_label || p?.concept || 'Cobro';

/**
 * Confirmación de aprobación de un cobro pendiente.
 * - Muestra el monto esperado y, si hay OCR del comprobante, el monto detectado
 *   con alerta de discrepancia.
 * - Permite aprobar COMPLETO (paid) o registrar un ABONO parcial (partial):
 *   acredita solo lo pagado (amount_paid) y deja saldo pendiente; notifica al
 *   padre el abono y el saldo.
 * - El abono solo se ofrece si la escuela lo tiene encendido
 *   (school_settings.allow_installments). Antes la hoja no lo miraba y, cuando el
 *   comprobante traía menos plata, se abría YA en modo abono: Dynasty (abonos
 *   apagados) terminó con dos cobros en `partial` el 2026-10-09 por aprobar con
 *   el botón que la hoja le dejó listo.
 * - Un comprobante de VARIOS cobros (mismo receipt_url, ver `siblings`): lista
 *   los cobros, compara el comprobante contra la SUMA de los marcados y los
 *   aprueba todos con un solo aviso a la familia. Caso origen (Dynasty,
 *   2026-11-06): Juliana Martínez Yopasa pagó $450.000 con el motivo «Pago
 *   Dynasty Sept Oct y Nov» y la hoja solo ofrecía aprobar septiembre.
 */
export function ApprovePaymentMethodSheet({ payment, open, onOpenChange, onSuccess, familyNote, siblings }: ApprovePaymentMethodSheetProps) {
  const { user } = useAuth();
  const { schoolId, schoolName } = useSchoolContext();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'full' | 'abono'>('full');
  const [abonoAmount, setAbonoAmount] = useState('');
  const [viewingReceipt, setViewingReceipt] = useState(false);
  // null = cargando. Mientras no se sepa, no se ofrece el abono.
  const [allowInstallments, setAllowInstallments] = useState<boolean | null>(null);
  // Sin abonos y con monto que no cuadra: aprobar el total exige confirmarlo.
  const [confirmFull, setConfirmFull] = useState(false);
  // Solo escuelas con school_settings.receipt_amount_editable (Dynasty): la escuela
  // puede corregir el valor realmente pagado respecto al que leyó el OCR.
  const [editable, setEditable] = useState(false);
  const [valorPagado, setValorPagado] = useState('');
  const [razon, setRazon] = useState('');
  // Comprobante de varios cobros: cuáles se aprueban (por defecto, todos).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── Grupo: este cobro + los que comparten comprobante ──
  const group: any[] = payment ? orderReceiptGroup([payment, ...(siblings ?? [])]) : [];
  const isGroup = group.length > 1;
  const groupKey = group.map((p) => p.id).join(',');
  const selected = isGroup ? group.filter((p) => selectedIds.has(p.id)) : group;
  const groupAllRemaining = group.reduce((s, p) => s + remainingOf(p), 0);
  const multipleAthletes = new Set(group.map((p) => p.athlete_name || '')).size > 1;
  const allMonths = selected.length > 0 && selected.every((p) => !!p.period_label);
  const noun = (n: number) => (allMonths ? (n === 1 ? 'mes' : 'meses') : (n === 1 ? 'cobro' : 'cobros'));

  // Lo debido = valor del cobro − pronto pago (lib/receiptReview.dueOf). Con
  // pronto pago la familia transfiere menos y NO es un abono: comparar contra
  // `amount` proponía un abono con «saldo» igual al descuento.
  const listAmount = Number(payment?.amount) || 0;
  const earlyDiscount = payment ? listAmount - dueOf(payment) : 0;
  const expected = payment ? dueOf(payment) : 0;
  const existingPaid = Number(payment?.amount_paid) || 0;   // abonos previos
  // Saldo por cubrir: el del cobro o, en grupo, la suma de los marcados.
  const remaining = isGroup
    ? selected.reduce((s, p) => s + remainingOf(p), 0)
    : (payment ? remainingOf(payment) : 0);
  // En grupo el monto leído está en el cobro que el bot estampó con la foto.
  const ocrRaw = isGroup ? group.find((p) => p.ocr_amount != null)?.ocr_amount : payment?.ocr_amount;
  const ocrAmount = ocrRaw != null ? Number(ocrRaw) : null;
  // Discrepancia: el OCR detectó un monto distinto al saldo por cubrir (tol. 0.5%).
  const hasDiscrepancy = ocrAmount != null && remaining > 0 &&
    Math.abs(ocrAmount - remaining) / remaining * 100 > 0.5;
  // Hay comprobante subido pero el OCR no pudo leer el monto: avisar para que el
  // admin verifique manualmente y no apruebe el total por defecto sin querer.
  const hasReceiptNoOcr = !!payment?.receipt_url && ocrAmount == null;

  useEffect(() => {
    if (!open || !schoolId) return;
    let cancelled = false;
    setAllowInstallments(null);
    supabase.from('school_settings').select('allow_installments').eq('school_id', schoolId).maybeSingle()
      .then(({ data }) => { if (!cancelled) setAllowInstallments(!!(data as { allow_installments?: boolean } | null)?.allow_installments); },
            () => { if (!cancelled) setAllowInstallments(false); });
    // Consulta aparte: si la columna aún no existe, no debe tumbar allow_installments.
    setEditable(false);
    supabase.from('school_settings').select('receipt_amount_editable').eq('school_id', schoolId).maybeSingle()
      .then(({ data }) => { if (!cancelled) setEditable(!!(data as { receipt_amount_editable?: boolean } | null)?.receipt_amount_editable); },
            () => { if (!cancelled) setEditable(false); });
    return () => { cancelled = true; };
  }, [open, schoolId]);

  // El abono es de UN cobro: con un comprobante de varios no se ofrece.
  const canAbono = allowInstallments === true && !isGroup;
  const ocrShort = ocrAmount != null && ocrAmount > 0 && ocrAmount < remaining;
  // Sin abonos, el aviso fuerte aplica a montos que no cuadran o no se leyeron.
  const needsFullConfirm = !canAbono && !editable && (hasDiscrepancy || hasReceiptNoOcr);

  // Al abrir: si el comprobante cubre menos que el saldo y la escuela recibe
  // abonos, sugerir modo abono con el valor del comprobante. Si no, completo.
  useEffect(() => {
    if (open && payment) {
      const suggestAbono = canAbono && ocrShort;
      setMode(suggestAbono ? 'abono' : 'full');
      setAbonoAmount(suggestAbono ? String(ocrAmount) : String(remaining));
      setConfirmFull(false);
      setSelectedIds(new Set(group.map((p) => p.id)));
      setValorPagado(String(ocrAmount != null && ocrAmount > 0 ? ocrAmount : (isGroup ? groupAllRemaining : remaining)));
      setRazon('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment?.id, canAbono, groupKey]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirmFull(false);
  };

  const abonoNum = Number(abonoAmount) || 0;               // este abono
  const newTotalPaid = existingPaid + abonoNum;            // acumulado tras este abono
  const isAbono = mode === 'abono' && newTotalPaid < expected;  // aún queda saldo
  const saldoPendiente = Math.max(expected - newTotalPaid, 0);

  // Valor corregido por la escuela (solo con el interruptor). Si es menor al saldo
  // queda como abono por ese valor; si cubre el saldo, se aprueba completo.
  // En grupo no hay abono: si no alcanza para los marcados, se desmarca el que sobra.
  const valorNum = Number(valorPagado) || 0;
  const valorBase = ocrAmount != null && ocrAmount > 0 ? ocrAmount : (isGroup ? groupAllRemaining : remaining);
  const valorCambiado = editable && valorNum !== valorBase;
  const groupShort = isGroup && editable && valorNum > 0 && valorNum < remaining;
  const valorInvalido = editable && (valorNum <= 0 || (valorCambiado && razon.trim().length < 3) || groupShort);
  const editAbono = editable && !isGroup && valorNum > 0 && valorNum < remaining;
  const nothingSelected = isGroup && selected.length === 0;

  const handleViewReceipt = async () => {
    if (!payment?.receipt_url) return;
    setViewingReceipt(true);
    try {
      const url = await getSignedReceiptUrl(payment.receipt_url);
      if (!url) {
        toast({
          title: 'No se pudo abrir el comprobante',
          description: 'Verifica que el archivo exista y que tengas permiso para verlo.',
          variant: 'destructive',
        });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setViewingReceipt(false);
    }
  };

  /**
   * Aprueba los cobros marcados del comprobante, uno por uno por el mismo camino
   * de siempre (approvePayment), y manda UN aviso con todos. Primero el que trae
   * el monto leído: ahí queda el valor confirmado, y el trigger de saldo a favor
   * (fn_payments_saldo_a_favor_al_aprobar) ve los demás con el mismo archivo y no
   * inventa un excedente.
   */
  const handleApproveGroup = async () => {
    if (!schoolId || !user) return;
    const ordered = orderReceiptGroup(selected);
    const ok: { payment: any; label: string }[] = [];
    const fails: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const first = i === 0;
      const r = await approvePayment(p, {
        userId: user.id,
        schoolId,
        schoolName,
        notify: false,
        confirmedAmount: editable && first ? valorNum : undefined,
        confirmedReason: editable && first && valorCambiado ? razon.trim() : undefined,
      });
      if ('reason' in r) fails.push(`${itemLabel(p)}: ${r.message}`);
      else ok.push({ payment: p, label: itemLabel(p) });
    }
    await notifyGroupApproved(ok, schoolName);

    if (fails.length === 0) {
      toast({
        title: `${ok.length} ${noun(ok.length)} aprobados`,
        description: `${joinSpanish(ok.map((o) => o.label))} quedaron pagados con el mismo comprobante.`,
      });
    } else {
      toast({
        title: `Se aprobaron ${ok.length} de ${ordered.length}`,
        description: `${fails.join(' · ')} Actualiza la lista.`,
        variant: 'destructive',
      });
    }
    onSuccess();
    onOpenChange(false);
  };

  const handleApprove = async () => {
    if (!payment || !schoolId || !user) return;

    if (editable && valorInvalido) {
      toast({
        title: 'Revisa el valor',
        description: valorNum <= 0
          ? 'El valor pagado debe ser mayor a 0.'
          : groupShort
            ? `No alcanza para los ${selected.length} ${noun(selected.length)} marcados (${formatCurrency(remaining)}). Desmarca los que no cubre.`
            : 'Si cambias el valor del comprobante, escribe la razón.',
        variant: 'destructive',
      });
      return;
    }
    if (nothingSelected) return;
    if (!editable && mode === 'abono' && !canAbono) return;
    if (mode === 'full' && needsFullConfirm && !confirmFull) return;
    if (!isGroup && mode === 'abono' && (abonoNum <= 0 || abonoNum > remaining)) {
      toast({ title: 'Monto inválido', description: `El abono debe ser mayor a 0 y no superar el saldo ${formatCurrency(remaining)}.`, variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      if (isGroup) {
        await handleApproveGroup();
        return;
      }

      // Mismo camino que «Aprobar todos los verdes» (lib/approvePayment): un
      // solo lugar para approved_by, amount_paid, inscripción y aviso.
      const r = await approvePayment(payment, {
        userId: user.id,
        schoolId,
        schoolName,
        abonoAmount: editable ? (editAbono ? valorNum : undefined) : (mode === 'abono' ? abonoNum : undefined),
        confirmedAmount: editable ? valorNum : undefined,
        confirmedReason: editable && valorCambiado ? razon.trim() : undefined,
      });
      if ('reason' in r) {
        toast({
          title: r.reason === 'already_handled' ? 'No se aprobó' : 'Error al aprobar',
          description: r.reason === 'already_handled' ? `${r.message} Actualiza la lista.` : r.message,
          variant: 'destructive',
        });
        if (r.reason === 'already_handled') { onSuccess(); onOpenChange(false); }
        return;
      }

      toast({
        title: r.isAbono ? 'Abono registrado' : 'Cobro aprobado',
        description: r.isAbono
          ? `Se acreditó ${formatCurrency(r.abono)}. Saldo pendiente: ${formatCurrency(r.saldoPendiente)}.`
          : 'El pago quedó confirmado y la inscripción activa.',
      });

      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      console.error(err);
      toast({
        title: 'Error al aprobar',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  if (!payment) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="sm:max-w-md mx-auto rounded-t-2xl px-6 pb-8 pt-6 max-h-[92vh] overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>{isGroup ? 'Aprobar comprobante' : 'Aprobar cobro'}</SheetTitle>
          <SheetDescription>
            {isGroup
              ? <>Un solo comprobante de <strong>{multipleAthletes ? 'varios deportistas' : (payment.athlete_name || 'este deportista')}</strong> que cubre {group.length} {allMonths ? 'meses' : 'cobros'}.</>
              : <>Confirma la aprobación del cobro de <strong>{payment.athlete_name || 'este deportista'}</strong>.</>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5">
          {/* Concepto + esperado */}
          {isGroup ? (
            <div className="bg-slate-50 p-4 rounded-xl border space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" /> Este comprobante cubre
              </p>
              <ul className="space-y-1.5">
                {group.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center justify-between gap-2 text-sm cursor-pointer">
                      <span className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelected(p.id)} />
                        <span className="truncate text-slate-700">
                          {itemLabel(p)}
                          {multipleAthletes && p.athlete_name ? <span className="text-slate-400"> · {p.athlete_name}</span> : null}
                        </span>
                      </span>
                      <span className={`font-semibold whitespace-nowrap ${selectedIds.has(p.id) ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                        {formatCurrency(remainingOf(p))}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-baseline justify-between pt-2 border-t border-slate-200">
                <p className="text-xs text-slate-400 uppercase tracking-wide">Esperado ({selected.length})</p>
                <p className="text-2xl font-bold text-slate-900">{formatCurrency(remaining)}</p>
              </div>
              <p className="text-[11px] text-slate-500">Revisa en la foto que el motivo diga esos meses. Desmarca el que no corresponda: queda en la cola.</p>
            </div>
          ) : (
          <div className="bg-slate-50 p-4 rounded-xl border">
            <p className="text-sm text-slate-500 mb-1">{payment.concept}</p>
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-slate-400 uppercase tracking-wide">Esperado</p>
              <p className="text-2xl font-bold text-slate-900">{formatCurrency(expected)}</p>
            </div>
            {earlyDiscount > 0 && (
              <p className="text-xs text-emerald-700 text-right">
                Valor {formatCurrency(listAmount)} − pronto pago {formatCurrency(earlyDiscount)}
              </p>
            )}
            {existingPaid > 0 && (
              <div className="flex items-baseline justify-between mt-1 pt-1 border-t border-slate-200">
                <p className="text-xs text-slate-400 uppercase tracking-wide">Ya abonado</p>
                <p className="text-sm font-bold text-emerald-600">{formatCurrency(existingPaid)} · saldo {formatCurrency(remaining)}</p>
              </div>
            )}
          </div>
          )}

          {familyNote && (
            <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/60">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">La familia escribió</p>
              <p className="text-sm text-slate-700 italic">«{familyNote}»</p>
            </div>
          )}

          {/* Comprobante detectado por OCR */}
          {ocrAmount != null && (
            <div className={`p-3 rounded-xl border flex items-center justify-between ${hasDiscrepancy ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
              <span className="text-xs font-semibold flex items-center gap-1.5 uppercase tracking-wide text-slate-600">
                <ScanLine className="h-3.5 w-3.5" /> Comprobante (OCR)
              </span>
              <span className={`text-lg font-bold flex items-center gap-1 ${hasDiscrepancy ? 'text-amber-700' : 'text-emerald-700'}`}>
                {hasDiscrepancy && <AlertTriangle className="h-4 w-4" />}
                {formatCurrency(ocrAmount)}
              </span>
            </div>
          )}
          {hasDiscrepancy && canAbono && (
            <p className="text-xs text-amber-700 -mt-2">
              El comprobante no coincide con el valor esperado. Verifica antes de aprobar: puedes registrarlo como <strong>abono</strong>.
            </p>
          )}

          {/* Comprobante subido pero OCR no leyó el monto: no aprobar el total a ciegas */}
          {hasReceiptNoOcr && (
            <div className="p-3 rounded-xl border border-amber-300 bg-amber-50 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">
                No se pudo leer el monto del comprobante automáticamente. <strong>Abre el comprobante y verifica el valor</strong> antes de aprobar.
                {canAbono
                  ? <> Si el pago fue menor al esperado, regístralo como <strong>abono</strong> con el monto real.</>
                  : <> Si el pago fue menor al esperado, no lo apruebes: usa <strong>Glosar</strong> para pedirle el resto a la familia.</>}
              </p>
            </div>
          )}

          {/* Rechazo previo de la pasarela. Informativo: aprobar lo destraba. */}
          {payment?.requires_review && (
            <div className="p-3 rounded-xl border border-amber-300 bg-amber-50 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">
                Este cobro venía marcado <strong>en revisión</strong> por un intento de pago con tarjeta rechazado
                {payment.last_failure_reason ? ` (${payment.last_failure_reason})` : ''}. Al aprobarlo se destraba.
              </p>
            </div>
          )}

          {/* Ver el comprobante subido (URL firmada; requiere RLS de escuela) */}
          {payment?.receipt_url && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={viewingReceipt}
              onClick={handleViewReceipt}
            >
              {viewingReceipt ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <FileText className="h-4 w-4 mr-2" />}
              Ver comprobante
            </Button>
          )}

          {/* Escuela sin abonos y el monto no cuadra: no hay abono que registrar. */}
          {needsFullConfirm && hasDiscrepancy && (
            <div className="p-3 rounded-xl border border-red-300 bg-red-50 space-y-1">
              <p className="text-xs font-bold text-red-700 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {isGroup ? 'El comprobante no cuadra con los cobros marcados' : 'Tu escuela no recibe abonos'}
              </p>
              <p className="text-xs text-red-700">
                {isGroup
                  ? <>El comprobante es de <strong>{formatCurrency(ocrAmount as number)}</strong> y los {selected.length} {noun(selected.length)} marcados suman <strong>{formatCurrency(remaining)}</strong>. Desmarca los que no cubre o, si falta plata, usa <strong>Glosar</strong>.</>
                  : <>El comprobante es de <strong>{formatCurrency(ocrAmount as number)}</strong> y el cobro de <strong>{formatCurrency(remaining)}</strong>.
                    Si falta plata, cierra esta ventana y usa <strong>Glosar</strong> para pedirle el resto a la familia, o <strong>Rechazar</strong>.</>}
              </p>
            </div>
          )}
          {needsFullConfirm && (
            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={confirmFull} onChange={(e) => setConfirmFull(e.target.checked)} />
              <span>Verifiqué que el pago de {formatCurrency(remaining)} está completo (por ejemplo, el resto llegó por otro medio).</span>
            </label>
          )}

          {/* Dynasty: corregir el valor realmente pagado respecto al comprobante */}
          {editable && (
            <div className="space-y-2 p-3 rounded-xl border border-blue-200 bg-blue-50/50">
              <Label htmlFor="valor-pagado" className="text-xs font-semibold uppercase tracking-wide text-slate-600">Valor realmente pagado</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold">$</span>
                <Input id="valor-pagado" type="number" min="0" value={valorPagado}
                  onChange={(e) => setValorPagado(e.target.value)} className="pl-7 text-lg font-bold" />
              </div>
              {valorCambiado && (
                <>
                  <p className="text-xs text-amber-700">
                    Distinto al comprobante ({formatCurrency(valorBase)}). Escribe la razón (por ejemplo: «pagó en dos transferencias»).
                  </p>
                  <Input placeholder="Razón del cambio" value={razon} onChange={(e) => setRazon(e.target.value)} />
                </>
              )}
              {editAbono && (
                <p className="text-xs text-blue-700">Es menor al saldo: queda como abono, saldo {formatCurrency(remaining - valorNum)}.</p>
              )}
              {groupShort && (
                <p className="text-xs text-red-700">
                  No alcanza para los {selected.length} {noun(selected.length)} marcados ({formatCurrency(remaining)}): desmarca los que no cubre.
                </p>
              )}
              {valorNum > remaining && remaining > 0 && (
                <p className="text-xs text-slate-600">
                  {isGroup
                    ? <>Es mayor a lo marcado ({formatCurrency(remaining)}): se aprueban y el valor queda anotado.</>
                    : <>Es mayor al cobro ({formatCurrency(remaining)}): se aprueba completo y el valor queda anotado.</>}
                </p>
              )}
            </div>
          )}

          {/* Selector Completo / Abono (solo si la escuela recibe abonos) */}
          {canAbono && !editable && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode('full')}
              className={`p-3 rounded-xl border text-sm font-semibold transition-all ${mode === 'full' ? 'border-emerald-500 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-200' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}
            >
              {existingPaid > 0 ? 'Completar saldo' : 'Pago completo'}
            </button>
            <button
              type="button"
              onClick={() => setMode('abono')}
              className={`p-3 rounded-xl border text-sm font-semibold transition-all ${mode === 'abono' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-2 ring-blue-200' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}
            >
              Registrar abono
            </button>
          </div>
          )}

          {/* Input de abono */}
          {canAbono && !editable && mode === 'abono' && (
            <div className="space-y-2">
              <Label htmlFor="abono" className="text-xs font-semibold uppercase tracking-wide text-slate-600">Monto abonado</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold">$</span>
                <Input
                  id="abono"
                  type="number"
                  min="0"
                  max={remaining}
                  value={abonoAmount}
                  onChange={(e) => setAbonoAmount(e.target.value)}
                  className="pl-7 text-lg font-bold"
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Saldo pendiente</span>
                <span className="font-bold text-amber-600">{formatCurrency(saldoPendiente)}</span>
              </div>
            </div>
          )}

          <Button
            className={`w-full h-12 text-base font-bold ${isAbono ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            disabled={loading || allowInstallments === null || valorInvalido || nothingSelected || (mode === 'full' && needsFullConfirm && !confirmFull)}
            onClick={handleApprove}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <CheckCircle2 className="h-5 w-5 mr-2" />}
            {loading
              ? 'Procesando...'
              : isGroup
                ? `Aprobar ${selected.length} ${noun(selected.length)} · ${formatCurrency(editable ? valorNum : remaining)}`
              : editable
                ? (editAbono ? `Registrar abono ${formatCurrency(valorNum)}` : `Aprobar con valor ${formatCurrency(valorNum)}`)
              : isAbono
                ? `Registrar abono ${formatCurrency(abonoNum)}`
                : `${existingPaid > 0 ? 'Completar saldo' : 'Aprobar'} ${formatCurrency(existingPaid > 0 ? remaining : expected)}`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
