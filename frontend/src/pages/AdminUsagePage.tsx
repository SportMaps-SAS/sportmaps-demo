import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

type Modo = { display_mode: 'browser' | 'standalone' | 'native'; usuarios: number; sesiones: number };
type Rol = { rol: string; usuarios: number; usuarios_app: number; sesiones: number };
type Dia = { dia: string; usuarios: number; sesiones: number };
type Escuela = { school_id: string | null; escuela: string; usuarios: number; usuarios_app: number; sesiones: number };
type Pantalla = { pantalla: string; vistas: number; usuarios: number };
type Boton = { pantalla: string; boton: string; clics: number; usuarios: number };
type Llamada = { metodo: string; ruta: string; estado: number; llamadas: number; usuarios: number };
type Resumen = {
  desde: string;
  dias: number;
  usuarios: number;
  por_modo: Modo[];
  por_rol: Rol[];
  por_dia: Dia[];
  por_escuela: Escuela[];
  top_pantallas: Pantalla[];
  top_botones: Boton[];
  api: Llamada[];
  errores_api: Llamada[];
};
type SchoolOption = { id: string; name: string };

const MODO_LABEL: Record<string, string> = {
  browser: 'Navegador',
  standalone: 'Acceso directo (PWA)',
  native: 'App nativa',
};

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '–');

export default function AdminUsagePage() {
  const [dias, setDias] = useState('30');
  const [schoolId, setSchoolId] = useState('all');
  const [internos, setInternos] = useState(false);

  const { data: schools = [] } = useQuery({
    queryKey: ['admin-usage-schools'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_schools_for_filter' as any);
      if (error) throw error;
      return ((data as any[]) || []) as SchoolOption[];
    },
  });

  // A demanda y con caché: la RPC agrega varios miles de filas en la base compartida.
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-usage', dias, schoolId, internos],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_ui_usage_resumen' as any, {
        p_days: Number(dias),
        p_school: schoolId === 'all' ? null : schoolId,
        p_internos: internos,
      });
      if (error) throw error;
      return data as unknown as Resumen;
    },
  });

  const totalUsuariosModo = data?.por_modo.reduce((s, m) => s + m.usuarios, 0) ?? 0;
  const usuariosApp = data?.por_modo.filter((m) => m.display_mode !== 'browser').reduce((s, m) => s + m.usuarios, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold">Uso de la app</h1>
        <p className="text-sm text-muted-foreground">
          Pantallas, botones y llamadas, agregados por usuario y día. Un usuario puede aparecer en más de un modo si entra desde varios dispositivos.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label>Período</Label>
          <Select value={dias} onValueChange={setDias}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Últimos 7 días</SelectItem>
              <SelectItem value="30">Últimos 30 días</SelectItem>
              <SelectItem value="90">Últimos 90 días</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Escuela</Label>
          <Select value={schoolId} onValueChange={setSchoolId}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {schools.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="internos" checked={internos} onCheckedChange={setInternos} />
          <Label htmlFor="internos">Incluir cuentas QA/demo</Label>
        </div>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && (
        <Card><CardContent className="pt-6 text-sm text-destructive">
          No se pudo cargar: {(error as Error).message}
        </CardContent></Card>
      )}

      {data && data.usuarios === 0 && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          Todavía no hay datos en este período. Aparecen cuando los usuarios abren la versión que ya trae el rastreador.
        </CardContent></Card>
      )}

      {data && data.usuarios > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card><CardHeader className="pb-2"><CardDescription>Usuarios con actividad</CardDescription>
              <CardTitle className="text-3xl">{data.usuarios}</CardTitle></CardHeader></Card>
            <Card><CardHeader className="pb-2"><CardDescription>Usan app o acceso directo</CardDescription>
              <CardTitle className="text-3xl">{pct(usuariosApp, totalUsuariosModo)}</CardTitle></CardHeader></Card>
            {data.por_modo.map((m) => (
              <Card key={m.display_mode}><CardHeader className="pb-2">
                <CardDescription>{MODO_LABEL[m.display_mode]}</CardDescription>
                <CardTitle className="text-3xl">{m.usuarios}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{m.sesiones} sesiones</span>
                </CardTitle></CardHeader></Card>
            ))}
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Usuarios activos por día</CardTitle></CardHeader>
            <CardContent className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.por_dia}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dia" tickFormatter={(d: string) => d.slice(5)} fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="usuarios" name="Usuarios" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Por rol</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Rol</TableHead><TableHead className="text-right">Usuarios</TableHead>
                    <TableHead className="text-right">En app</TableHead><TableHead className="text-right">Sesiones</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.por_rol.map((r) => (
                      <TableRow key={r.rol}>
                        <TableCell>{r.rol}</TableCell>
                        <TableCell className="text-right">{r.usuarios}</TableCell>
                        <TableCell className="text-right">{pct(r.usuarios_app, r.usuarios)}</TableCell>
                        <TableCell className="text-right">{r.sesiones}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {data.por_escuela.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Por escuela</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Escuela</TableHead><TableHead className="text-right">Usuarios</TableHead>
                      <TableHead className="text-right">En app</TableHead><TableHead className="text-right">Sesiones</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {data.por_escuela.map((e) => (
                        <TableRow key={e.school_id ?? 'sin'}>
                          <TableCell className="max-w-[14rem] truncate">{e.escuela}</TableCell>
                          <TableCell className="text-right">{e.usuarios}</TableCell>
                          <TableCell className="text-right">{pct(e.usuarios_app, e.usuarios)}</TableCell>
                          <TableCell className="text-right">{e.sesiones}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Pantallas más vistas</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Pantalla</TableHead><TableHead className="text-right">Vistas</TableHead>
                    <TableHead className="text-right">Usuarios</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.top_pantallas.map((p) => (
                      <TableRow key={p.pantalla}>
                        <TableCell className="font-mono text-xs">{p.pantalla}</TableCell>
                        <TableCell className="text-right">{p.vistas}</TableCell>
                        <TableCell className="text-right">{p.usuarios}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Botones más usados</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Botón</TableHead><TableHead>Pantalla</TableHead>
                    <TableHead className="text-right">Clics</TableHead><TableHead className="text-right">Usuarios</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.top_botones.map((b) => (
                      <TableRow key={`${b.pantalla}|${b.boton}`}>
                        <TableCell>{b.boton}</TableCell>
                        <TableCell className="font-mono text-xs">{b.pantalla}</TableCell>
                        <TableCell className="text-right">{b.clics}</TableCell>
                        <TableCell className="text-right">{b.usuarios}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <LlamadasCard titulo="Acciones que fallan (4xx, 5xx, sin red)" filas={data.errores_api} />
            <LlamadasCard titulo="Llamadas al servidor más frecuentes" filas={data.api} />
          </div>
        </>
      )}
    </div>
  );
}

function LlamadasCard({ titulo, filas }: { titulo: string; filas: Llamada[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{titulo}</CardTitle></CardHeader>
      <CardContent>
        {filas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin registros en el período.</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Llamada</TableHead><TableHead>Estado</TableHead>
              <TableHead className="text-right">Veces</TableHead><TableHead className="text-right">Usuarios</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filas.map((a) => (
                <TableRow key={`${a.metodo}|${a.ruta}|${a.estado}`}>
                  <TableCell className="font-mono text-xs">{a.metodo} {a.ruta}</TableCell>
                  <TableCell>
                    <Badge variant={a.estado === 0 || a.estado >= 400 ? 'destructive' : 'secondary'}>
                      {a.estado === 0 ? 'sin red' : a.estado}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{a.llamadas}</TableCell>
                  <TableCell className="text-right">{a.usuarios}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
