/**
 * Ajustes del pago por plazos (administración): prender la función, topes de
 * cuotas y de días, y aprobación automática. Se lee por el BFF y se guarda en
 * el BFF (`PUT /api/v1/payment-agreements/settings/:schoolId`).
 *
 * Esta tarjeta SIEMPRE se ve (es la que prende la función); la bandeja no.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAjustesAcuerdos, guardarAjustesAcuerdos, validarAjustes, type AjustesAcuerdos as Ajustes } from '@/lib/api/acuerdosDePago';

const POR_DEFECTO: Ajustes = { habilitado: false, max_cuotas: 3, max_dias: 60, auto_aprobar: true };

export function AjustesAcuerdos({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ['acuerdos-ajustes', schoolId], queryFn: () => fetchAjustesAcuerdos(schoolId) });
    const [form, setForm] = useState<Ajustes>(POR_DEFECTO);
    const [textoCuotas, setTextoCuotas] = useState('3');
    const [textoDias, setTextoDias] = useState('60');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!q.data) return;
        setForm(q.data);
        setTextoCuotas(String(q.data.max_cuotas));
        setTextoDias(String(q.data.max_dias));
    }, [q.data]);

    const guardar = useMutation({
        mutationFn: (a: Ajustes) => guardarAjustesAcuerdos(schoolId, a),
        onSuccess: () => {
            toast({ title: 'Ajustes guardados' });
            qc.invalidateQueries({ queryKey: ['acuerdos-ajustes', schoolId] });
        },
        onError: (e) => toast({ variant: 'destructive', title: 'No se pudieron guardar los ajustes', description: getUserFriendlyError(e) }),
    });

    const onGuardar = () => {
        const a: Ajustes = { ...form, max_cuotas: Number(textoCuotas), max_dias: Number(textoDias) };
        const msg = validarAjustes(a);
        setError(msg);
        if (!msg) guardar.mutate(a);
    };

    if (q.isLoading) return <Skeleton className="h-40 w-full" aria-label="Cargando ajustes de pago por plazos" />;

    return (
        <Card>
            <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">Pago por plazos</CardTitle>
                <CardDescription>Las familias podrán pedir pagar sus cobros abiertos en cuotas, dentro de los topes que pongas aquí.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-2">
                {q.isError && (
                    <p role="alert" className="text-sm text-destructive">No pudimos leer los ajustes actuales ({getUserFriendlyError(q.error)}). Lo que guardes reemplaza los valores de la escuela.</p>
                )}
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="acuerdos-habilitado" className="flex-1">Permitir pago por plazos</Label>
                    <Switch id="acuerdos-habilitado" checked={form.habilitado} onCheckedChange={(v) => setForm((f) => ({ ...f, habilitado: v }))} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                        <Label htmlFor="acuerdos-max-cuotas">Máximo de cuotas</Label>
                        <Input id="acuerdos-max-cuotas" inputMode="numeric" value={textoCuotas} onChange={(e) => setTextoCuotas(e.target.value.replace(/\D/g, ''))} aria-describedby="acuerdos-ayuda-topes" />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="acuerdos-max-dias">Máximo de días para terminar de pagar</Label>
                        <Input id="acuerdos-max-dias" inputMode="numeric" value={textoDias} onChange={(e) => setTextoDias(e.target.value.replace(/\D/g, ''))} aria-describedby="acuerdos-ayuda-topes" />
                    </div>
                </div>
                <p id="acuerdos-ayuda-topes" className="text-xs text-muted-foreground">Un acuerdo que pase de estos topes llega a la bandeja para que lo apruebes o lo rechaces.</p>
                <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                        <Label htmlFor="acuerdos-auto">Aprobar automáticamente dentro de los topes</Label>
                        <p className="text-xs text-muted-foreground">Apagado: cada acuerdo espera tu aprobación.</p>
                    </div>
                    <Switch id="acuerdos-auto" checked={form.auto_aprobar} onCheckedChange={(v) => setForm((f) => ({ ...f, auto_aprobar: v }))} />
                </div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <Button onClick={onGuardar} disabled={guardar.isPending}>
                    {guardar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                    Guardar ajustes
                </Button>
            </CardContent>
        </Card>
    );
}

export default AjustesAcuerdos;
