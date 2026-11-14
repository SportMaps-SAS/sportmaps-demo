/**
 * SportMapsPaySettings — Configuración de pagos online para owners/admins
 *
 * MODELO DE COBRO (importante para no volver a escribir copy engañoso):
 * el recargo por pago online es de la ESCUELA. El padre lo paga sumado a la
 * mensualidad, el bruto entra completo a la cuenta de la escuela en la pasarela,
 * y sirve para cubrirle la comisión que la pasarela le descuenta al liquidar.
 * SportMaps NO participa de la transacción ni retiene nada: su ingreso es el
 * addon de integración, que se cobra por fuera del flujo de pago.
 *
 * Lee y actualiza school_settings para controlar:
 * - Activación/desactivación de Wompi
 * - Porcentaje del recargo por pago online
 * - Quién asume el recargo (parent/school/split)
 * - Aceptación de términos de SportMaps Pay
 */

import { useState, useEffect } from 'react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { AlertTriangle, CreditCard, Shield, Save, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { bffClient } from '@/lib/api/bffClient';

/**
 * Modo de cobro de la escuela (schools.payment_mode). Es el interruptor que de
 * verdad decide si se puede cobrar online, y lo lee el BFF en
 * payment-provider.resolver.ts. `wompi_enabled` solo controla si el botón se ve.
 */
type ModoPago = 'unset' | 'aggregator' | 'direct';

/** Lo que devuelve GET /api/v1/payment-providers/school/:id, recortado. */
interface ProviderEstado {
    provider: 'wompi' | 'mercadopago';
    enabled: boolean;
    connect_status: string;
    secrets?: { hasAccessToken: boolean; hasPrivateKey: boolean };
}

interface PaySettings {
    wompi_enabled: boolean;
    online_fee_pct: number;
    fee_payer: 'parent' | 'school' | 'split';
    transfer_day: string;
    sportmaps_pay_terms_accepted_at: string | null;
    sportmaps_pay_terms_accepted_by: string | null;
}

const FEE_PAYERS = [
    { value: 'parent', label: 'Padre/Atleta (recomendado)', description: 'El recargo se suma al monto del pago' },
    { value: 'school', label: 'Escuela', description: 'El recargo se descuenta del monto recibido' },
    { value: 'split', label: 'Compartido 50/50', description: 'Mitad para cada parte' },
];

const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(amount);

export function SportMapsPaySettings() {
    const { schoolId } = useSchoolContext();
    const { user } = useAuth();
    const [settings, setSettings] = useState<PaySettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [modoPago, setModoPago] = useState<ModoPago>('unset');
    /** Providers propios usables. null = no se pudo leer (no se asume lo peor). */
    const [providersUsables, setProvidersUsables] = useState<number | null>(null);

    useEffect(() => {
        if (schoolId) loadSettings();
    }, [schoolId]);

    // Espejo de la regla del BFF (payment-provider.resolver.ts): quién puede
    // cobrar online. Si esto se desalinea del resolver, vuelve el botón que no
    // cobra. Va acá arriba porque handleSave lo usa.
    const cuentaLista =
        modoPago === 'aggregator'
            ? true
            : modoPago === 'direct'
                ? (providersUsables === null || providersUsables > 0)
                : false;

    const motivoBloqueo = cuentaLista
        ? null
        : modoPago === 'direct'
            ? 'Tienes cuenta propia seleccionada, pero no hay credenciales de pasarela conectadas.'
            : 'Todavía no tienes una cuenta de recaudo conectada.';

    // Estado heredado: el botón ya se les muestra a los padres pero el cobro
    // muere en el BFF. Se tiene que poder apagar, así que el switch no se bloquea.
    const incoherente = !!settings?.wompi_enabled && !cuentaLista;

    async function loadSettings() {
        if (!schoolId) return;
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('school_settings')
                .select('wompi_enabled, online_fee_pct, fee_payer, transfer_day, sportmaps_pay_terms_accepted_at, sportmaps_pay_terms_accepted_by')
                .eq('school_id', schoolId)
                .single();

            if (error) throw error;

            const s = data as any;
            setSettings({
                wompi_enabled: s?.wompi_enabled ?? false,
                online_fee_pct: Number(s?.online_fee_pct ?? 3),
                fee_payer: s?.fee_payer ?? 'parent',
                transfer_day: s?.transfer_day ?? 'monday',
                sportmaps_pay_terms_accepted_at: s?.sportmaps_pay_terms_accepted_at ?? null,
                sportmaps_pay_terms_accepted_by: s?.sportmaps_pay_terms_accepted_by ?? null,
            });
            setTermsAccepted(!!s?.sportmaps_pay_terms_accepted_at);

            // Sin esto la escuela podía prender el botón "Pagar online" con
            // payment_mode='unset': el padre hacía clic y el resolver del BFF
            // devolvía null, así que el cobro moría sin explicación.
            const { data: escuela } = await supabase
                .from('schools')
                .select('payment_mode')
                .eq('id', schoolId)
                .maybeSingle();
            const modo = (((escuela as any)?.payment_mode ?? 'unset') as ModoPago);
            setModoPago(modo);

            if (modo === 'direct') {
                // 'direct' sin credenciales propias conectadas también bloquea el
                // cobro. Se pregunta al BFF y no a PostgREST a propósito: la RLS
                // de school_payment_providers solo alcanza al dueño, así que un
                // admin que no lo sea leería 0 filas y vería "falta conectar"
                // sobre una escuela bien configurada. El BFF además dice qué
                // secretos existen, que es lo que el resolver exige de verdad.
                try {
                    const res = await bffClient.get<{ providers: ProviderEstado[] }>(
                        `/api/v1/payment-providers/school/${schoolId}`,
                    );
                    setProvidersUsables(
                        (res.providers ?? []).filter(p =>
                            p.enabled
                            && ['connected', 'connected_pending_webhook'].includes(p.connect_status)
                            // Mismo mínimo que toResolved(): sin este secreto el
                            // resolver devuelve null y el cobro no sale.
                            && (p.provider === 'wompi'
                                ? p.secrets?.hasPrivateKey
                                : p.secrets?.hasAccessToken),
                        ).length,
                    );
                } catch {
                    // 403 o red caída: no se sabe, y no se asume lo peor.
                    setProvidersUsables(null);
                }
            } else {
                setProvidersUsables(null);
            }
        } catch (error) {
            console.error('Error loading pay settings:', error);
            toast.error('Error al cargar configuración de pagos.');
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        if (!schoolId || !settings) return;

        // Cinturón además del switch deshabilitado: prender wompi_enabled sin
        // cuenta de recaudo es justo el bug que esto cierra.
        if (settings.wompi_enabled && !cuentaLista) {
            toast.error('No se puede activar el cobro online sin una cuenta de recaudo conectada.');
            return;
        }

        try {
            setSaving(true);

            const updateData: TablesUpdate<'school_settings'> = {
                wompi_enabled: settings.wompi_enabled,
                online_fee_pct: settings.online_fee_pct,
                fee_payer: settings.fee_payer,
                transfer_day: settings.transfer_day,
            };

            // Si es la primera vez que activa y acepta términos
            if (settings.wompi_enabled && !settings.sportmaps_pay_terms_accepted_at && termsAccepted) {
                updateData.sportmaps_pay_terms_accepted_at = new Date().toISOString();
                updateData.sportmaps_pay_terms_accepted_by = user?.id;
            }

            const { error } = await supabase
                .from('school_settings')
                .update(updateData)
                .eq('school_id', schoolId);

            if (error) throw error;

            toast.success('✅ Configuración de pagos guardada.');
            loadSettings(); // Recargar
        } catch (error: any) {
            console.error('Error saving pay settings:', error);
            toast.error(error.message || 'Error al guardar.');
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <Card>
                <CardContent className="py-12 flex justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    if (!settings) return null;

    // Ejemplo de cálculo para preview
    const exampleBase = 100000;
    const exampleFee = Math.round(exampleBase * (settings.online_fee_pct / 100));
    const exampleTotal = exampleBase + exampleFee;

    return (
        <Card className="border-primary/20">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <CreditCard className="h-5 w-5 text-primary" />
                    SportMaps Pay
                    {incoherente ? (
                        <Badge variant="destructive" className="text-xs">Activo, pero sin cobrar</Badge>
                    ) : settings.wompi_enabled ? (
                        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-xs">
                            Activo
                        </Badge>
                    ) : (
                        <Badge variant="outline" className="text-xs">Inactivo</Badge>
                    )}
                </CardTitle>
                <CardDescription>
                    Permite a tus padres y atletas pagar online con tarjeta, PSE o Nequi a través de Wompi.
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
                {/* ── Cuenta de recaudo ─────────────────────────────────── */}
                {incoherente && (
                    <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                            <span className="font-medium">Los pagos online están fallando.</span>{' '}
                            El botón "Pagar online" se les muestra a los padres, pero el cobro
                            no puede completarse: {motivoBloqueo?.toLowerCase()} Apaga los pagos
                            online mientras conectas la cuenta, para que nadie quede a mitad de
                            camino.
                        </AlertDescription>
                    </Alert>
                )}

                {!cuentaLista && !incoherente && (
                    <Alert>
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                            <span className="font-medium">Falta conectar tu cuenta de recaudo.</span>{' '}
                            {motivoBloqueo} Sin ella no se puede activar el cobro online: el dinero
                            no tendría a dónde llegar. Escríbenos para conectarla —no nos mandes tus
                            llaves por chat— y en cuanto quede lista podrás activar el botón desde acá.
                        </AlertDescription>
                    </Alert>
                )}

                {/* ── Toggle principal ──────────────────────────────────── */}
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <Label htmlFor="wompi-toggle" className="text-base font-medium">
                            Activar pagos online
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            Habilita el botón "Pagar online" en la vista de pagos de los padres.
                        </p>
                    </div>
                    <Switch
                        id="wompi-toggle"
                        checked={settings.wompi_enabled}
                        // Se puede APAGAR siempre (para salir de un estado
                        // incoherente); prenderlo exige cuenta de recaudo lista.
                        disabled={!cuentaLista && !settings.wompi_enabled}
                        onCheckedChange={(checked) => setSettings({ ...settings, wompi_enabled: checked })}
                    />
                </div>

                <Separator />

                {/* ── Configuración (solo si está activo o se va a activar) ── */}
                {(settings.wompi_enabled || settings.sportmaps_pay_terms_accepted_at) && (
                    <>
                        {/* Fee */}
                        <div className="space-y-3">
                            <Label htmlFor="fee-pct" className="text-sm font-medium">
                                Recargo por pago online
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                Se suma a la mensualidad y lo recibes tú, junto con el resto del pago.
                                Sirve para cubrir la comisión que Wompi te descuenta por cada transacción.
                            </p>
                            <div className="flex items-center gap-3">
                                <Input
                                    id="fee-pct"
                                    type="number"
                                    min={0}
                                    max={10}
                                    step={0.5}
                                    value={settings.online_fee_pct}
                                    onChange={(e) => setSettings({ ...settings, online_fee_pct: parseFloat(e.target.value) || 0 })}
                                    className="w-24"
                                />
                                <span className="text-sm text-muted-foreground">%</span>
                            </div>

                            {/* Preview del cálculo */}
                            <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1">
                                <p className="font-medium text-xs text-muted-foreground mb-2">Ejemplo con mensualidad de {formatCurrency(exampleBase)}:</p>
                                <div className="flex justify-between">
                                    <span>Base</span>
                                    <span>{formatCurrency(exampleBase)}</span>
                                </div>
                                <div className="flex justify-between text-amber-600">
                                    <span>Recargo ({settings.online_fee_pct}%)</span>
                                    <span>+{formatCurrency(exampleFee)}</span>
                                </div>
                                <div className="flex justify-between font-bold border-t pt-1">
                                    <span>Total padre paga</span>
                                    <span>{formatCurrency(exampleTotal)}</span>
                                </div>
                                <div className="flex justify-between text-green-600 text-xs mt-1">
                                    <span>Entra a tu cuenta Wompi</span>
                                    <span>{formatCurrency(exampleTotal)}</span>
                                </div>
                                <p className="text-[11px] text-muted-foreground pt-1">
                                    Wompi descuenta su comisión de ese total al liquidarte. El recargo
                                    está para compensarla; el porcentaje exacto lo ves en tu dashboard de Wompi.
                                </p>
                            </div>
                        </div>

                        {/* Quién paga */}
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">¿Quién paga el fee?</Label>
                            <Select
                                value={settings.fee_payer}
                                onValueChange={(v) => setSettings({ ...settings, fee_payer: v as any })}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {FEE_PAYERS.map(({ value, label, description }) => (
                                        <SelectItem key={value} value={value}>
                                            <div>
                                                <p className="font-medium">{label}</p>
                                                <p className="text-xs text-muted-foreground">{description}</p>
                                            </div>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Liquidación — la hace la pasarela, no SportMaps.
                            Antes acá había un selector de "día de transferencia" que decía
                            que SportMaps giraba los fondos acumulados a la cuenta bancaria
                            de la escuela. Eso nunca fue cierto: el dinero entra directo al
                            comercio de la escuela y SportMaps no lo toca en ningún momento. */}
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">¿Cuándo recibes el dinero?</Label>
                            <p className="text-xs text-muted-foreground">
                                Los pagos entran directo a tu cuenta de Wompi, y Wompi te liquida a tu
                                cuenta bancaria según los tiempos de tu contrato con ellos. SportMaps no
                                retiene ni intermedia esos fondos.
                            </p>
                        </div>

                        <Separator />

                        {/* ── Términos ──────────────────────────────────────── */}
                        {settings.sportmaps_pay_terms_accepted_at ? (
                            <div className="flex items-center gap-2 text-sm text-green-600">
                                <CheckCircle2 className="h-4 w-4" />
                                <span>
                                    Términos aceptados el{' '}
                                    {new Date(settings.sportmaps_pay_terms_accepted_at).toLocaleDateString('es-CO')}
                                </span>
                            </div>
                        ) : settings.wompi_enabled ? (
                            <Alert>
                                <AlertTriangle className="h-4 w-4" />
                                <AlertDescription className="text-sm">
                                    <label className="flex items-start gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={termsAccepted}
                                            onChange={(e) => setTermsAccepted(e.target.checked)}
                                            className="mt-0.5"
                                        />
                                        <span>
                                            Acepto los términos y condiciones de SportMaps Pay.
                                            Entiendo que el {settings.online_fee_pct}% se suma a cada pago online y entra
                                            a mi cuenta de Wompi junto con la mensualidad, para compensar la comisión que
                                            Wompi me descuenta al liquidar. SportMaps no retiene ningún porcentaje de las
                                            transacciones: la integración de pagos se cobra aparte, en el plan.
                                        </span>
                                    </label>
                                </AlertDescription>
                            </Alert>
                        ) : null}

                        {/* ── Seguridad ─────────────────────────────────────── */}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Shield className="h-4 w-4 text-green-600" />
                            <span>Pagos procesados de forma segura por Wompi (Bancolombia). SportMaps nunca ve los datos de tarjeta.</span>
                        </div>
                    </>
                )}

                {/* ── Botón guardar ─────────────────────────────────────── */}
                <Button
                    onClick={handleSave}
                    disabled={
                        saving
                        || (settings.wompi_enabled && !cuentaLista)
                        || (settings.wompi_enabled && !settings.sportmaps_pay_terms_accepted_at && !termsAccepted)
                    }
                    className="w-full"
                >
                    {saving ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</>
                    ) : (
                        <><Save className="mr-2 h-4 w-4" />Guardar configuración de pagos</>
                    )}
                </Button>
            </CardContent>
        </Card>
    );
}
