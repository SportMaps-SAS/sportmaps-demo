/**
 * Precios especiales de un servicio del catálogo (`school_tournament_items`,
 * migración M2 `comprobantes_con_motivo`): precio para afiliados, opciones
 * («1 semana», «2 semanas»…), cambio de precio por fecha y abono mínimo para
 * separar el cupo. Cuatro secciones plegables dentro del formulario de
 * SellableCatalogCard; ninguna es obligatoria y cerradas no estorban.
 *
 * Caso que lo pidió (Monster, 2026-10-30): la clínica a $250.000 para
 * afiliados, preventa $300.000 y desde el 10 de noviembre $350.000, cupo con
 * el 50 %; y el vacacional con precio por semanas para afiliados y externos.
 * Las reglas de precio viven en lib/preciosDeServicio.ts (las mismas del bot).
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    abonoMinimo,
    parsePesos,
    precioGeneralEn,
    type FilaFecha,
    type FilaOpcion,
    type FormularioDePrecios,
} from '@/lib/preciosDeServicio';
import { todayColombia } from '@/lib/dateUtils';

const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`;

function Seccion({ titulo, resumen, abierta, children }: { titulo: string; resumen: string | null; abierta: boolean; children: ReactNode }) {
    const [open, setOpen] = useState(abierta);
    return (
        <details
            open={open}
            onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="group rounded-lg border bg-background"
        >
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
                <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform -rotate-90 group-open:rotate-0" />
                <span className="flex-1">{titulo}</span>
                <span className={`text-[11px] ${resumen ? 'text-primary font-semibold' : 'text-muted-foreground font-normal'}`}>{resumen ?? 'No'}</span>
            </summary>
            <div className="space-y-2 px-3 pb-3">{children}</div>
        </details>
    );
}

interface Props {
    value: FormularioDePrecios;
    onChange: (next: FormularioDePrecios) => void;
    /** Lo que está escrito en «Precio (COP)»: base para la vista previa. */
    precioBase: string;
    disabled?: boolean;
}

export function PreciosDeServicioEditor({ value, onChange, precioBase, disabled = false }: Props) {
    const set = (patch: Partial<FormularioDePrecios>) => onChange({ ...value, ...patch });
    const setOpcion = (i: number, patch: Partial<FilaOpcion>) =>
        set({ opciones: value.opciones.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
    const setFecha = (i: number, patch: Partial<FilaFecha>) =>
        set({ preciosPorFecha: value.preciosPorFecha.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

    const hoy = todayColombia();
    const base = parsePesos(precioBase);
    const fechasValidas = value.preciosPorFecha
        .map((f) => ({ desde: f.desde, precio: parsePesos(f.precio) }))
        .filter((f): f is { desde: string; precio: number } => !!f.desde && f.precio !== null && !Number.isNaN(f.precio));
    const precioHoy = base !== null && !Number.isNaN(base) ? precioGeneralEn({ price: base, precios_por_fecha: fechasValidas }, hoy) : null;
    const pct = Number(value.abonoPct);
    const abonoHoy = precioHoy !== null && Number.isInteger(pct) && pct >= 1 && pct <= 100 ? abonoMinimo(precioHoy, pct) : null;
    const af = parsePesos(value.precioAfiliado);
    const opcionesLlenas = value.opciones.filter((o) => o.etiqueta.trim()).length;
    const fechasLlenas = value.preciosPorFecha.filter((f) => f.desde).length;

    return (
        <div className="space-y-2 sm:col-span-2" data-testid="precios-de-servicio">
            <Seccion
                titulo="Precio para afiliados"
                resumen={af !== null && !Number.isNaN(af) ? pesos(af) : null}
                abierta={!!value.precioAfiliado.trim()}
            >
                <p className="text-[11px] text-muted-foreground">
                    Lo que paga quien ya es del club (deportistas y sus familias). Vacío = el mismo precio para todos.
                </p>
                <Input
                    aria-label="Precio para afiliados (COP)"
                    placeholder="Ej. 250000"
                    inputMode="numeric"
                    value={value.precioAfiliado}
                    disabled={disabled}
                    onChange={(e) => set({ precioAfiliado: e.target.value })}
                    className="h-9 text-sm sm:max-w-48"
                />
            </Seccion>

            <Seccion
                titulo="Opciones"
                resumen={opcionesLlenas > 0 ? (opcionesLlenas === 1 ? '1 opción' : `${opcionesLlenas} opciones`) : null}
                abierta={value.opciones.length > 0}
            >
                <p className="text-[11px] text-muted-foreground">
                    Para elegir entre varias, p. ej. «1 semana», «2 semanas». Cada una con su precio; se cobra la que elija la familia.
                </p>
                {value.opciones.map((o, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-md border p-2 sm:grid-cols-[1.4fr_1fr_1fr_auto] sm:border-0 sm:p-0">
                        <Input
                            aria-label={`Nombre de la opción ${i + 1}`}
                            placeholder="Ej. 1 semana"
                            value={o.etiqueta}
                            maxLength={40}
                            disabled={disabled}
                            onChange={(e) => setOpcion(i, { etiqueta: e.target.value })}
                            className="col-span-2 h-9 text-sm sm:col-span-1"
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-9 w-9 p-0 sm:order-last"
                            aria-label={`Quitar la opción ${i + 1}`}
                            disabled={disabled}
                            onClick={() => set({ opciones: value.opciones.filter((_, j) => j !== i) })}
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                        <Input
                            aria-label={`Precio de la opción ${i + 1}`}
                            placeholder="Precio"
                            inputMode="numeric"
                            value={o.precio}
                            disabled={disabled}
                            onChange={(e) => setOpcion(i, { precio: e.target.value })}
                            className="h-9 text-sm"
                        />
                        <Input
                            aria-label={`Precio para afiliados de la opción ${i + 1}`}
                            placeholder="Afiliados (opcional)"
                            inputMode="numeric"
                            value={o.precioAfiliado}
                            disabled={disabled}
                            onChange={(e) => setOpcion(i, { precioAfiliado: e.target.value })}
                            className="h-9 text-sm"
                        />
                    </div>
                ))}
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={disabled}
                    onClick={() => set({ opciones: [...value.opciones, { etiqueta: '', precio: '', precioAfiliado: '' }] })}
                >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Agregar opción
                </Button>
            </Seccion>

            <Seccion
                titulo="Cambio de precio por fecha"
                resumen={fechasLlenas > 0 ? (fechasLlenas === 1 ? '1 cambio' : `${fechasLlenas} cambios`) : null}
                abierta={value.preciosPorFecha.length > 0}
            >
                <p className="text-[11px] text-muted-foreground">
                    Desde esa fecha el precio cambia (p. ej. termina la preventa). El precio para afiliados no cambia.
                </p>
                {value.preciosPorFecha.map((f, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <Input
                            type="date"
                            aria-label={`Desde (cambio ${i + 1})`}
                            value={f.desde}
                            disabled={disabled}
                            onChange={(e) => setFecha(i, { desde: e.target.value })}
                            className="h-9 text-sm"
                        />
                        <Input
                            aria-label={`Precio desde esa fecha (cambio ${i + 1})`}
                            placeholder="Nuevo precio"
                            inputMode="numeric"
                            value={f.precio}
                            disabled={disabled}
                            onChange={(e) => setFecha(i, { precio: e.target.value })}
                            className="h-9 text-sm"
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-9 w-9 p-0"
                            aria-label={`Quitar el cambio ${i + 1}`}
                            disabled={disabled}
                            onClick={() => set({ preciosPorFecha: value.preciosPorFecha.filter((_, j) => j !== i) })}
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                ))}
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={disabled}
                    onClick={() => set({ preciosPorFecha: [...value.preciosPorFecha, { desde: '', precio: '' }] })}
                >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Agregar fecha
                </Button>
                {precioHoy !== null && fechasValidas.length > 0 && (
                    <p className="text-[11px] text-muted-foreground" aria-live="polite">Hoy cuesta {pesos(precioHoy)}.</p>
                )}
            </Seccion>

            <Seccion
                titulo="Separar cupo con abono"
                resumen={value.abonoPct.trim() ? `${value.abonoPct.trim()} %` : null}
                abierta={!!value.abonoPct.trim()}
            >
                <p className="text-[11px] text-muted-foreground">
                    La familia separa el cupo pagando una parte y el resto queda pendiente, con el precio de ese día.
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Input
                        aria-label="Abono mínimo (% del precio)"
                        placeholder="50"
                        inputMode="numeric"
                        value={value.abonoPct}
                        disabled={disabled}
                        onChange={(e) => set({ abonoPct: e.target.value })}
                        className="h-9 w-20 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">% del precio</span>
                    {abonoHoy !== null && <span className="text-xs text-muted-foreground" aria-live="polite">= {pesos(abonoHoy)} hoy</span>}
                </div>
            </Seccion>
        </div>
    );
}
