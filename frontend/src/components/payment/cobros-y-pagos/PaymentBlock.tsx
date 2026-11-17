import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Banknote, Building2, CheckCircle2, Loader2, Receipt } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { FileUpload } from '@/components/common/FileUpload';
import { BillingDetailsForm } from '@/components/billing/BillingDetailsForm';
import { cn } from '@/lib/utils';
import { formatPesos } from '@/lib/cobrosYPagos';
import { mensajeDeComprobante, type DecisionComprobante } from '@/lib/separarHoras';
import type { PaymentChargeCategory } from '@/lib/payment-accounts';
import { sinComprobante, type PaymentDraft } from './drafts';
import { RecibidoSinComprobanteCampos } from '@/components/payment/RecibidoSinComprobanteCampos';


type PayerDianState = 'complete' | 'no_dane' | 'incomplete';
const DANE_CODE = /^\d{4,5}$/;

interface PaymentBlockProps {
    value: PaymentDraft;
    onChange: (next: PaymentDraft) => void;
    today: string;
    schoolId: string | null;
    totalToPay: number;
    /** Monto que el OCR debería ver (suma de lo que se paga). */
    expectedAmount?: number;
    paymentCategory: PaymentChargeCategory | null;
    /** Pagador del atleta para la factura electrónica (null = sin perfil). */
    payerProfileId: string | null;
    payerName: string | null;
    payerKind: 'adult_athlete' | 'guardian';
    invoicingEnabled: boolean;
    /** Veredicto del comprobante contra el total cuando la operación vende horas (lib/separarHoras). */
    comprobante?: DecisionComprobante;
    /** «Separar las horas»: deja el comprobante para lo principal y pasa las horas a otra operación. */
    onSepararHoras?: () => void;
}

/**
 * «Ya lo pagaron» (§10.2): método, fecha, referencia, comprobante (solo en
 * transferencia, con el validador OCR de siempre) y factura electrónica. Lo que
 * conservaba «Registrar pago»: validador del comprobante con la categoría del
 * cobro, avisos del motor de reglas sin bloquear (el admin ya vio la plata) y
 * el estado fiscal del pagador.
 */
export function PaymentBlock({
    value: p, onChange, today, schoolId, totalToPay, expectedAmount, paymentCategory,
    payerProfileId, payerName, payerKind, invoicingEnabled, comprobante, onSepararHoras,
}: PaymentBlockProps) {
    // Último borrador, ACUMULADO: dos cambios en el mismo evento (p. ej. «Efectivo» + quitar el
    // comprobante, o el resultado del OCR + la URL subida) parten del anterior y no del `p` de
    // este render. Antes cada `set` armaba `{ ...p, ...patch }` con el `p` viejo y el segundo
    // pisaba al primero: «Efectivo» volvía solo a «Transferencia» (Dreamers, 2026-10-21).
    const ultimo = useRef(p);
    ultimo.current = p;
    const set = (patch: Partial<PaymentDraft>) => {
        const next = { ...ultimo.current, ...patch };
        ultimo.current = next;
        onChange(next);
    };
    const [uploadKey, setUploadKey] = useState(0);
    const [dian, setDian] = useState<PayerDianState | null>(null);
    const [checkingDian, setCheckingDian] = useState(false);
    const [showBilling, setShowBilling] = useState(false);

    useEffect(() => {
        if (!p.on || !payerProfileId || !invoicingEnabled) { setDian(null); return; }
        let cancelled = false;
        setCheckingDian(true);
        (async () => {
            const { data } = await supabase.from('profiles')
                .select('document_type, document_number, billing_address, billing_city_dane')
                .eq('id', payerProfileId).maybeSingle();
            if (cancelled) return;
            const emitible = !!(data?.document_number && data?.billing_address);
            const conDane = DANE_CODE.test(String(data?.billing_city_dane ?? '').trim());
            setDian(!emitible ? 'incomplete' : conDane ? 'complete' : 'no_dane');
            setCheckingDian(false);
        })();
        return () => { cancelled = true; };
    }, [p.on, payerProfileId, invoicingEnabled]);

    const clearReceipt = () => { set({ receiptUrl: null, ocr: null }); setUploadKey((k) => k + 1); };

    const verdictWarnings: string[] = (() => {
        if (!p.ocr?.verdict || p.ocr.verdict === 'verde') return [];
        const reasons = Array.isArray(p.ocr.verdictReasons) ? p.ocr.verdictReasons : [];
        return reasons.map((r) => (r as { message?: string })?.message).filter((m): m is string => typeof m === 'string' && m.length > 0);
    })();

    return (
        <div className="rounded-xl border p-3 space-y-3" data-testid="cyp-payment-block">
            <div className="flex items-center justify-between gap-2">
                <Label htmlFor="cyp-paid" className="font-bold">Ya lo pagaron</Label>
                <Switch id="cyp-paid" checked={p.on} onCheckedChange={(v) => set({ on: v })} />
            </div>
            {!p.on && <p className="text-xs text-muted-foreground">Sin esta casilla los pendientes marcados solo reciben ajustes y los cobros nuevos quedan por pagar.</p>}
            {p.on && (
                <>
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Método de pago">
                        {([['cash', 'Efectivo', Banknote], ['transfer', 'Transferencia', Building2]] as const).map(([m, label, Icon]) => (
                            <button
                                key={m}
                                type="button"
                                role="radio"
                                aria-checked={p.method === m}
                                onClick={() => { set({ method: m }); if (m === 'cash' && p.receiptUrl) clearReceipt(); }}
                                className={cn(
                                    'flex items-center justify-center gap-2 rounded-lg border-2 h-11 text-sm font-semibold transition-colors',
                                    p.method === m ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30',
                                )}
                            >
                                <Icon className="h-4 w-4" /> {label}
                            </button>
                        ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <Label htmlFor="cyp-pay-date" className="text-xs">Fecha del pago</Label>
                            <Input id="cyp-pay-date" type="date" max={today} value={p.date} onChange={(e) => set({ date: e.target.value })} className="h-10" />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="cyp-pay-ref" className="text-xs">Referencia <span className="text-muted-foreground font-normal">(opcional)</span></Label>
                            <Input id="cyp-pay-ref" value={p.reference} onChange={(e) => set({ reference: e.target.value })} className="h-10" maxLength={80} />
                        </div>
                    </div>

                    {sinComprobante(p) && (
                        <RecibidoSinComprobanteCampos
                            value={{ metodo: p.method, fecha: p.date, por: p.receivedBy }}
                            onChange={(v) => set({ receivedBy: v.por })}
                            hoy={today}
                            mostrarMetodo={false}
                            mostrarFecha={false}
                            idPrefix="cyp-recibido"
                        />
                    )}

                    {p.method === 'transfer' && (
                        <div className="space-y-2">
                            <Label className="text-xs">Comprobante <span className="text-muted-foreground font-normal">(opcional)</span></Label>
                            {p.receiptUrl ? (
                                <div className="rounded-lg border border-primary/30 bg-primary/5 p-2 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="flex items-center gap-1.5 text-xs font-semibold text-primary"><CheckCircle2 className="h-4 w-4" /> Soporte adjunto</span>
                                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearReceipt}>Quitar</Button>
                                    </div>
                                    {p.ocr?.extractedAmount != null && expectedAmount != null && p.ocr.extractedAmount !== expectedAmount && (
                                        <p className="text-xs text-amber-700 dark:text-amber-400">
                                            El comprobante dice {formatPesos(p.ocr.extractedAmount)} y se registran {formatPesos(expectedAmount)}.
                                        </p>
                                    )}
                                    {comprobante?.tipo === 'bloquear' && (
                                        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 space-y-2" role="alert" data-testid="cyp-comprobante-horas">
                                            <p className="flex items-start gap-1.5 text-xs font-semibold text-destructive">
                                                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> No se puede confirmar así
                                            </p>
                                            <p className="text-xs text-destructive">{mensajeDeComprobante(comprobante)}</p>
                                            {comprobante.puedeSeparar && onSepararHoras && (
                                                <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={onSepararHoras} data-testid="cyp-separar-horas">
                                                    Separar las horas
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                    {p.ocr?.extractedDate && p.ocr.extractedDate !== p.date && (
                                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => set({ date: p.ocr!.extractedDate! })}>
                                            Usar fecha {p.ocr.extractedDate}
                                        </Button>
                                    )}
                                    {verdictWarnings.length > 0 && (
                                        <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 p-2">
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                                            <div className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                                                <p className="font-bold">Revisa antes de confirmar:</p>
                                                {verdictWarnings.map((m, i) => <p key={i}>{m}</p>)}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <FileUpload
                                    key={uploadKey}
                                    bucket="payment-receipts"
                                    accept="image/*,application/pdf"
                                    validateReceipt
                                    dateMode="any"
                                    blockOnRedVerdict={false}
                                    schoolId={schoolId || undefined}
                                    expectedAmount={expectedAmount && expectedAmount > 0 ? expectedAmount : undefined}
                                    paymentCategory={paymentCategory}
                                    onUploadComplete={(url) => set({ receiptUrl: url })}
                                    onValidationResult={(r) => set({ ocr: r })}
                                />
                            )}
                        </div>
                    )}

                    {invoicingEnabled && (
                        <div className="rounded-lg border bg-muted/20 p-2.5 space-y-2">
                            {!payerProfileId ? (
                                <p className="text-[11px] text-amber-700 dark:text-amber-400 flex gap-1.5">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                    Sin acudiente con cuenta: no hay a quién cargarle los datos fiscales, así que este pago no se puede facturar a nombre del pagador.
                                </p>
                            ) : checkingDian ? (
                                <span className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando datos de facturación…</span>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between gap-2">
                                        <Label htmlFor="cyp-einvoice" className="text-xs font-semibold flex items-center gap-1.5">
                                            <Receipt className="h-4 w-4 text-primary" /> Factura electrónica
                                        </Label>
                                        <Switch id="cyp-einvoice" checked={p.wantsEInvoice} onCheckedChange={(v) => set({ wantsEInvoice: v })} />
                                    </div>
                                    {dian === 'complete' && <p className="text-[11px] text-emerald-700 dark:text-emerald-400">Datos de facturación completos.</p>}
                                    {dian === 'no_dane' && <p className="text-[11px] text-amber-700 dark:text-amber-400">Falta el municipio con código DANE: la factura sale con la ciudad de la escuela.</p>}
                                    {dian === 'incomplete' && <p className="text-[11px] text-amber-700 dark:text-amber-400">Faltan documento o dirección del pagador: complétalos para que la factura salga.</p>}
                                    {dian && dian !== 'complete' && (
                                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowBilling((v) => !v)}>
                                            {showBilling ? 'Cerrar' : 'Completar datos'}
                                        </Button>
                                    )}
                                    {showBilling && (
                                        <BillingDetailsForm
                                            userId={payerProfileId}
                                            schoolId={schoolId || undefined}
                                            payerName={payerName || undefined}
                                            payerKind={payerKind}
                                            onComplete={() => { setDian('complete'); setShowBilling(false); }}
                                        />
                                    )}
                                </>
                            )}
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">Se registran {formatPesos(totalToPay)}.</p>
                </>
            )}
        </div>
    );
}
