/**
 * Freno de emergencia de campañas (pantalla /admin/whatsapp, solo plataforma).
 *
 * SportMaps NO crea, aprueba ni envía campañas por una escuela (spec
 * whatsapp-autoservicio, 2026-11-15). Lo único que hace desde aquí es FRENAR:
 * todas las escuelas a la vez (freno global) o una sola. Una pausa de plataforma
 * no la puede levantar la escuela; también nace así el freno automático que
 * salta dos veces en menos de 7 días.
 */
import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { OctagonAlert, Pause, Play } from 'lucide-react';

interface Escuela {
    school_id: string; nombre: string; habilitadas: boolean;
    pausada_at: string | null; pausa_motivo: string | null; pausa_origen: string | null;
}
interface Estado { freno: { pausada: boolean; desde: string | null; motivo: string | null }; escuelas: Escuela[] }

const BASE = '/api/v1/admin/whatsapp-plataforma/campanas';

const ORIGEN: Record<string, string> = {
    freno: 'Pausa automática (la escuela puede reanudar)',
    escuela: 'La pausó la escuela',
    plataforma: 'Pausa de SportMaps',
};

export function FrenoDeCampanasPlataforma() {
    const [estado, setEstado] = useState<Estado | null>(null);
    const [motivo, setMotivo] = useState('');
    const [ocupado, setOcupado] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        try {
            setEstado(await bffClient.get<Estado>(BASE));
        } catch {
            setEstado(null);
        }
    }, []);
    useEffect(() => { void cargar(); }, [cargar]);

    const enviar = async (clave: string, ruta: string, pausar: boolean) => {
        setOcupado(clave);
        try {
            await bffClient.post(ruta, { pausar, motivo: motivo.trim() || null });
            toast({ title: pausar ? 'Campañas en pausa' : 'Pausa levantada' });
            setMotivo('');
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo', description: e?.body?.error ?? e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    if (!estado) return null;
    const { freno, escuelas } = estado;

    return (
        <Card data-testid="freno-de-campanas">
            <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                    <OctagonAlert className="h-4 w-4" /> Campañas de las escuelas: freno de emergencia
                </CardTitle>
                <CardDescription>
                    Las escuelas crean, aprueban y envían sus campañas. Desde aquí solo se pueden detener.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
                <Input value={motivo} maxLength={500} placeholder="Motivo de la pausa (lo ve el equipo; opcional)"
                    aria-label="Motivo de la pausa" onChange={(e) => setMotivo(e.target.value)} />

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                    <div>
                        <p className="font-medium">Todas las escuelas</p>
                        <p className="text-muted-foreground">
                            {freno.pausada
                                ? `Detenidas desde ${new Date(freno.desde!).toLocaleString('es-CO')}${freno.motivo ? ` · ${freno.motivo}` : ''}`
                                : 'Funcionando. Con el freno puesto, nadie aprueba ni envía.'}
                        </p>
                    </div>
                    <Button variant={freno.pausada ? 'default' : 'destructive'} disabled={ocupado !== null}
                        onClick={() => void enviar('global', `${BASE}/freno`, !freno.pausada)}>
                        {freno.pausada ? <><Play className="h-4 w-4 mr-1" /> Quitar el freno global</> : <><Pause className="h-4 w-4 mr-1" /> Detener todas</>}
                    </Button>
                </div>

                {escuelas.length === 0 && <p className="text-muted-foreground">Ninguna escuela tiene campañas configuradas.</p>}
                {escuelas.map((e) => {
                    const dePlataforma = e.pausa_origen === 'plataforma';
                    return (
                        <div key={e.school_id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                            <div>
                                <p className="font-medium flex items-center gap-2">
                                    {e.nombre || e.school_id}
                                    {!e.habilitadas && <Badge variant="outline">Sin activar</Badge>}
                                    {e.pausada_at && <Badge variant="destructive">En pausa</Badge>}
                                </p>
                                {e.pausada_at && (
                                    <p className="text-muted-foreground">
                                        {ORIGEN[e.pausa_origen ?? 'freno']}{e.pausa_motivo ? ` · ${e.pausa_motivo}` : ''}
                                    </p>
                                )}
                            </div>
                            {dePlataforma ? (
                                <Button size="sm" disabled={ocupado !== null}
                                    onClick={() => void enviar(e.school_id, `${BASE}/escuelas/${e.school_id}/pausa`, false)}>
                                    <Play className="h-4 w-4 mr-1" /> Levantar pausa
                                </Button>
                            ) : (
                                <Button size="sm" variant="outline" disabled={ocupado !== null}
                                    onClick={() => void enviar(e.school_id, `${BASE}/escuelas/${e.school_id}/pausa`, true)}>
                                    <Pause className="h-4 w-4 mr-1" /> Pausar esta escuela
                                </Button>
                            )}
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}
