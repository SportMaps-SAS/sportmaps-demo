/**
 * /p/:token — enlace público de UN cobro, sin login.
 *
 * Es el destino del botón de las plantillas de cobranza de WhatsApp
 * (https://sportmaps.co/p/<token>; la landing redirige /p/* a app.sportmaps.co).
 * Muestra el cobro y deja pagarlo:
 *   · en línea, si la escuela tiene pasarela en producción (Wompi), con la firma
 *     calculada por el BFF — no hay sesión para pedírsela a la Edge Function;
 *   · por transferencia a las cuentas de la escuela, y mandar el comprobante
 *     por el WhatsApp de la escuela (lo lee el bot de comprobantes).
 * Nada de lo que se muestra identifica al acudiente: solo escuela, concepto,
 * nombre corto del deportista y montos. Mobile first: se abre desde WhatsApp.
 *
 * Orden (2026-10-05, "todo es todo para facilitarles"): si hay pago en línea
 * (Wompi; depende de PAGO_PUBLICO_PERMITE_LLAVES_ENV en el BFF) va PRIMERO,
 * justo debajo del valor. Después la transferencia: cada llave con su botón de
 * copiar, el QR de pago que cargó la escuela, el QR de este mismo enlace (para
 * abrirlo en otro celular) y el WhatsApp para el comprobante. Al final, los
 * otros cobros pendientes de la familia, cada uno con su enlace. Sin pago en
 * línea la página funciona igual con transferencia y QR.
 *
 * Link de pago genérico (2026-10-06, Dynasty): si la escuela cargó uno en sus
 * llaves (type 'payment_link'), va como botón «Pagar con tarjeta, PSE o Nequi
 * (Wompi)» antes de la transferencia; detrás del pago en línea propio si existe.
 *
 * Pago en línea con el monto ya puesto (2026-10-06): el botón «Pagar $X en
 * línea» lleva al Web Checkout de Wompi con el valor firmado por el BFF
 * (`checkoutUrl`, wompi-link-con-monto); el webhook lo aplica solo. Si el BFF no
 * manda `checkoutUrl` (versión anterior), se abre el Widget como antes.
 *
 * Factura electrónica (2026-10-05): bloque «¿Quieres factura electrónica?» con
 * id="factura" — el correo del estado de cuenta enlaza a /p/<token>#factura.
 * Solo aparece si el BFF dice que está disponible (migración aplicada y el
 * cobro tiene a quién atribuirle la preferencia). Nunca muestra los datos
 * guardados completos: el enlace se puede reenviar.
 *
 * Subir el comprobante aquí mismo (2026-10-13, Dreamers sin WhatsApp): si el BFF
 * dice `subirComprobante`, aparece «Sube tu comprobante» (foto o PDF). Va al
 * BFF por el token y deja el cobro en revisión igual que el bot de WhatsApp.
 * Con WhatsApp activo queda como alternativa debajo del botón de WhatsApp.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
    AlertCircle, CheckCircle2, Clock, Copy, CreditCard, ExternalLink, ListChecks, Loader2, MessageCircle, Landmark, QrCode, Upload, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BFFError } from '@/lib/api/bffClient';
import { textoBotonLinkDePago } from '@/lib/payment-accounts';
import { cargarWidgetWompi } from '@/lib/wompiWidget';
import {
    abrirWidgetWompi, guardarFacturaPublica, iniciarPagoCobroPublico, obtenerCobroPublico, obtenerFacturaPublica,
    subirComprobanteCobroPublico, type EstadoCobro, type VistaCobroPublico,
} from '@/lib/api/cobroPublico';
import { FacturaElectronicaPreferencia } from '@/components/billing/FacturaElectronicaPreferencia';
import { ETIQUETA_TIPO, esTipoDocumento, type ResumenFacturaPublica } from '@/lib/facturaElectronica';

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

const fecha = (d: string | null) =>
    d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

const ETIQUETA: Record<EstadoCobro, { texto: string; clase: string }> = {
    pendiente: { texto: 'Pendiente', clase: 'bg-amber-100 text-amber-800' },
    vencido: { texto: 'Vencido', clase: 'bg-red-100 text-red-800' },
    en_revision: { texto: 'Comprobante en revisión', clase: 'bg-blue-100 text-blue-800' },
    pagado: { texto: 'Pagado', clase: 'bg-green-100 text-green-800' },
    abono: { texto: 'Con abono', clase: 'bg-amber-100 text-amber-800' },
    anulado: { texto: 'Anulado', clase: 'bg-gray-200 text-gray-700' },
    rechazado: { texto: 'Comprobante rechazado', clase: 'bg-red-100 text-red-800' },
};

type Carga =
    | { tipo: 'cargando' }
    | { tipo: 'error'; titulo: string; detalle: string }
    | { tipo: 'ok'; vista: VistaCobroPublico };

export default function CobroPublicoPage() {
    const { token = '' } = useParams<{ token: string }>();
    const [params] = useSearchParams();
    const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
    const [pagando, setPagando] = useState(false);
    const [aviso, setAviso] = useState<string | null>(null);
    const [copiado, setCopiado] = useState<string | null>(null);
    const sondeo = useRef<number | null>(null);

    const cargar = useCallback(async (silencioso = false) => {
        if (!silencioso) setCarga({ tipo: 'cargando' });
        try {
            const vista = await obtenerCobroPublico(token);
            setCarga({ tipo: 'ok', vista });
            return vista;
        } catch (e) {
            const status = e instanceof BFFError ? e.status : 0;
            if (status === 404) {
                setCarga({ tipo: 'error', titulo: 'Enlace no válido', detalle: 'Revisa que el enlace esté completo o pídele uno nuevo a la escuela.' });
            } else if (status === 410) {
                setCarga({ tipo: 'error', titulo: 'Este enlace ya no está disponible', detalle: (e as Error).message });
            } else if (!silencioso) {
                setCarga({ tipo: 'error', titulo: 'No pudimos cargar el cobro', detalle: 'Revisa tu conexión e intenta de nuevo.' });
            }
            return null;
        }
    }, [token]);

    // Tras pagar, el estado lo pone el webhook de la pasarela (segundos). Se
    // consulta unas veces y se para apenas figure pagado.
    const sondear = useCallback(() => {
        let intentos = 0;
        if (sondeo.current) window.clearInterval(sondeo.current);
        sondeo.current = window.setInterval(async () => {
            intentos += 1;
            const v = await cargar(true);
            if ((v && v.estado === 'pagado') || intentos >= 10) {
                if (sondeo.current) window.clearInterval(sondeo.current);
                sondeo.current = null;
            }
        }, 3000);
    }, [cargar]);

    useEffect(() => {
        void cargar();
        // Regreso desde el redirect de Wompi (pagos que salen del Widget, p.ej. PSE).
        if (params.get('id')) sondear();
        return () => { if (sondeo.current) window.clearInterval(sondeo.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    async function pagarEnLinea() {
        setPagando(true);
        setAviso(null);
        let resultado: ReturnType<typeof abrirWidgetWompi> = null;
        try {
            const checkout = await iniciarPagoCobroPublico(token);
            const vuelta = `${window.location.origin}/p/${encodeURIComponent(token)}`;
            // Link de Web Checkout con el monto ya puesto y firmado (BFF ≥ 2026-10-06):
            // se navega a Wompi en la misma pestaña y al terminar vuelve aquí con
            // ?id=<tx>, que dispara el sondeo. No depende del script del Widget,
            // que en algunos celulares no carga. redirect-url no va en la firma.
            const url = (checkout as typeof checkout & { checkoutUrl?: string }).checkoutUrl;
            if (url && url.startsWith('https://checkout.wompi.co/')) {
                window.location.assign(`${url}&redirect-url=${encodeURIComponent(vuelta)}`);
                return;
            }
            // El script del Widget ya no va en index.html: se carga al pagar.
            await cargarWidgetWompi();
            resultado = abrirWidgetWompi(checkout, vuelta);
            if (!resultado) {
                setAviso('No pudimos abrir la pasarela de pago. Intenta de nuevo o paga por transferencia.');
            }
        } catch (e) {
            setAviso((e as Error).message || 'No pudimos iniciar el pago.');
            void cargar(true);
        } finally {
            // El Widget ya está en pantalla: no se espera su resultado para soltar
            // el botón (si lo cierran sin pagar, Wompi nunca llama al callback).
            setPagando(false);
        }
        const tx = resultado ? await resultado : null;
        if (tx?.status === 'APPROVED' || tx?.status === 'PENDING') {
            setAviso(tx.status === 'APPROVED'
                ? 'Pago aprobado. Estamos confirmándolo con la escuela…'
                : 'Tu pago está en proceso. Te mostramos el resultado apenas llegue.');
            sondear();
        } else if (tx?.status === 'DECLINED' || tx?.status === 'ERROR') {
            setAviso('El pago no se completó. Puedes intentarlo de nuevo o pagar por transferencia.');
        }
    }

    async function copiar(numero: string) {
        try {
            await navigator.clipboard.writeText(numero);
            setCopiado(numero);
            window.setTimeout(() => setCopiado(null), 2000);
        } catch {
            /* sin permiso de portapapeles: el número igual está a la vista */
        }
    }

    if (carga.tipo === 'cargando') {
        return (
            <main className="min-h-screen flex items-center justify-center bg-gray-50">
                <Loader2 className="h-8 w-8 animate-spin text-gray-400" aria-label="Cargando" />
            </main>
        );
    }

    if (carga.tipo === 'error') {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-10">
                <div className="mx-auto max-w-md rounded-2xl bg-white p-6 text-center shadow-sm">
                    <AlertCircle className="mx-auto h-10 w-10 text-gray-400" />
                    <h1 className="mt-3 text-lg font-semibold text-gray-900">{carga.titulo}</h1>
                    <p className="mt-2 text-sm text-gray-600">{carga.detalle}</p>
                    <Button asChild variant="outline" className="mt-5 w-full">
                        <a href="/login">Entrar a SportMaps</a>
                    </Button>
                </div>
                <PieSportMaps />
            </main>
        );
    }

    const v = carga.vista;
    const etiqueta = ETIQUETA[v.estado];
    const pagable = ['pendiente', 'vencido', 'abono', 'rechazado'].includes(v.estado);

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-6">
            <div className="mx-auto max-w-md space-y-4">
                <header className="flex items-center gap-3">
                    {v.escuela.logoUrl ? (
                        <img src={v.escuela.logoUrl} alt="" className="h-12 w-12 rounded-full object-cover bg-white" />
                    ) : (
                        <div className="h-12 w-12 rounded-full bg-gray-200" aria-hidden />
                    )}
                    <div className="min-w-0">
                        <p className="text-xs text-gray-500">Cobro de</p>
                        <h1 className="truncate text-base font-semibold text-gray-900">{v.escuela.nombre}</h1>
                    </div>
                </header>

                <section className="rounded-2xl bg-white p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900">
                                {v.concepto}{v.periodo ? ` · ${v.periodo}` : ''}
                            </p>
                            {v.deportista && <p className="text-sm text-gray-600">{v.deportista}</p>}
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${etiqueta.clase}`}>
                            {etiqueta.texto}
                        </span>
                    </div>
                    <p className="mt-4 text-3xl font-bold text-gray-900">{cop(v.monto)}</p>
                    {(Number(v.late_fee_amount) || 0) > 0 && (
                        <p className="mt-1 text-sm font-medium text-amber-700">
                            Incluye recargo por mora: {cop(Number(v.late_fee_amount))}
                        </p>
                    )}
                    {v.fechaVencimiento && v.estado !== 'pagado' && (
                        <p className="mt-1 flex items-center gap-1 text-sm text-gray-600">
                            <Clock className="h-4 w-4" /> Vence el {fecha(v.fechaVencimiento)}
                        </p>
                    )}
                    {v.estado === 'pagado' && (
                        <p className="mt-3 flex items-center gap-2 text-sm text-green-700">
                            <CheckCircle2 className="h-5 w-5" />
                            Pago registrado{v.fechaPago ? ` el ${fecha(v.fechaPago)}` : ''}. ¡Gracias!
                        </p>
                    )}
                    {v.estado === 'en_revision' && (
                        <p className="mt-3 text-sm text-blue-700">
                            La escuela está revisando tu comprobante. No tienes que hacer nada más.
                        </p>
                    )}
                    {v.estado === 'anulado' && (
                        <p className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                            <XCircle className="h-5 w-5" /> Este cobro fue anulado por la escuela.
                        </p>
                    )}
                </section>

                {aviso && (
                    <p role="status" className="rounded-xl bg-white p-3 text-sm text-gray-700 shadow-sm">{aviso}</p>
                )}

                {pagable && v.enLinea && (
                    <section className="rounded-2xl bg-white p-5 shadow-sm">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <CreditCard className="h-4 w-4" /> Pagar en línea
                        </h2>
                        <p className="mt-1 text-xs text-gray-600">
                            Tarjeta, PSE, Nequi o Bancolombia.
                            {v.enLinea.recargo > 0 && ` Incluye ${cop(v.enLinea.recargo)} de recargo por pago en línea (${v.enLinea.recargoPct}%).`}
                        </p>
                        <Button className="mt-4 h-12 w-full text-base" onClick={pagarEnLinea} disabled={pagando}>
                            {pagando ? <Loader2 className="h-5 w-5 animate-spin" /> : `Pagar ${cop(v.enLinea.total)} en línea`}
                        </Button>
                        <p className="mt-2 text-xs text-gray-600">
                            El valor ya va puesto. Al aprobarse, el pago queda aplicado solo: no tienes que mandar comprobante.
                        </p>
                    </section>
                )}

                {/* Link de pago genérico de la escuela (Wompi de Dynasty, 2026-10-06).
                    Si hay pago en línea propio (`enLinea`, conciliado solo) ese va
                    primero y este queda como alternativa; si no, este es el camino
                    en línea. Wompi no sabe a qué cobro corresponde: por eso el aviso
                    de escribir el valor y mandar el comprobante. */}
                {pagable && v.transferencia.linkDePago && (
                    <section className="rounded-2xl bg-white p-5 shadow-sm">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <CreditCard className="h-4 w-4" /> {v.enLinea ? 'O paga con el link de la escuela' : 'Pagar en línea'}
                        </h2>
                        <Button asChild variant={v.enLinea ? 'outline' : 'default'} className="mt-3 h-12 w-full text-base">
                            <a href={v.transferencia.linkDePago} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="mr-2 h-5 w-5" /> {textoBotonLinkDePago(v.transferencia.linkDePago)}
                            </a>
                        </Button>
                        <p className="mt-2 text-xs text-gray-600">
                            Escribe el valor de tu cobro (<strong>{cop(v.monto)}</strong>) y, al terminar, manda el comprobante
                            por WhatsApp o súbelo en la app para que la escuela lo aplique.
                        </p>
                    </section>
                )}

                {pagable && (v.transferencia.cuentas.length > 0 || v.transferencia.whatsappComprobante) && (
                    <section className="rounded-2xl bg-white p-5 shadow-sm">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <Landmark className="h-4 w-4" /> {v.enLinea || v.transferencia.linkDePago ? 'O transfiere' : 'Paga por transferencia'}
                        </h2>
                        {v.transferencia.cuentas.length > 0 ? (
                            <ul className="mt-3 space-y-2">
                                {v.transferencia.cuentas.map((c) => (
                                    <li key={c.numero} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-3">
                                        <div className="min-w-0">
                                            <p className="text-xs text-gray-500">{c.tipo}{c.titular ? ` · ${c.titular}` : ''}</p>
                                            <p className="break-all font-mono text-sm text-gray-900">{c.numero}</p>
                                        </div>
                                        <Button
                                            size="sm" variant="ghost" className="shrink-0"
                                            onClick={() => copiar(c.numero)}
                                            aria-label={`Copiar ${c.numero}`}
                                        >
                                            {copiado === c.numero ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-2 text-sm text-gray-600">Pídele a la escuela los datos para transferir.</p>
                        )}
                        <p className="mt-3 text-xs text-gray-600">Valor a transferir: <strong>{cop(v.monto)}</strong></p>
                        {v.transferencia.qrEscuelaUrl && (
                            <div className="mt-4 text-center">
                                <p className="flex items-center justify-center gap-1 text-xs font-medium text-gray-700">
                                    <QrCode className="h-4 w-4" /> QR de pago de la escuela
                                </p>
                                <img
                                    src={v.transferencia.qrEscuelaUrl}
                                    alt={`QR de pago de ${v.escuela.nombre}`}
                                    className="mx-auto mt-2 w-56 max-w-full rounded-lg border border-gray-100"
                                    loading="lazy"
                                />
                                <p className="mt-1 text-xs text-gray-500">Escanéalo desde la app de tu banco.</p>
                            </div>
                        )}
                        {v.transferencia.whatsappComprobante && (
                            <Button asChild variant="outline" className="mt-4 h-12 w-full">
                                <a href={v.transferencia.whatsappComprobante} target="_blank" rel="noopener noreferrer">
                                    <MessageCircle className="mr-2 h-5 w-5" /> Enviar comprobante por WhatsApp
                                </a>
                            </Button>
                        )}
                    </section>
                )}

                {pagable && v.subirComprobante && (
                    <BloqueSubirComprobante
                        token={token}
                        hayWhatsApp={!!v.transferencia.whatsappComprobante}
                        onSubido={() => { void cargar(true); }}
                    />
                )}

                {v.otrosPendientes && v.otrosPendientes.length > 0 && (
                    <section className="rounded-2xl bg-white p-5 shadow-sm">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <ListChecks className="h-4 w-4" /> Otros cobros pendientes
                        </h2>
                        <ul className="mt-3 space-y-2">
                            {v.otrosPendientes.map((o) => (
                                <li key={o.token}>
                                    <Link
                                        to={`/p/${encodeURIComponent(o.token)}`}
                                        className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-3 hover:bg-gray-50"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate text-sm text-gray-900">
                                                {o.concepto}{o.periodo ? ` · ${o.periodo}` : ''}
                                            </p>
                                            <p className="text-xs text-gray-500">
                                                {o.deportista ?? ''}{o.fechaVencimiento ? `${o.deportista ? ' · ' : ''}vence ${fecha(o.fechaVencimiento)}` : ''}
                                                {o.vencido && <span className="ml-1 text-red-700">· Vencido</span>}
                                            </p>
                                        </div>
                                        <span className="shrink-0 text-sm font-semibold text-gray-900">{cop(o.monto)}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                <BloqueFacturaPublica token={token} />

                {/* Consentimiento para avisos por WhatsApp: el enlace abre WhatsApp con
                    «… ACTIVAR AVISOS» prellenado y la familia lo envía desde su número
                    (esa es la prueba del consentimiento; aquí no se registra nada). */}
                {v.whatsappAvisos && (
                    <section className="rounded-2xl bg-white p-5 shadow-sm">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <MessageCircle className="h-4 w-4" /> Avisos por WhatsApp
                        </h2>
                        <p className="mt-2 text-sm text-gray-600">
                            ¿Quieres que {v.escuela.nombre} te envíe por WhatsApp los recordatorios de pago,
                            la confirmación de tus pagos y los avisos de tu deportista?
                        </p>
                        <Button asChild variant="outline" className="mt-3 h-12 w-full">
                            <a href={v.whatsappAvisos} target="_blank" rel="noopener noreferrer">
                                <MessageCircle className="mr-2 h-5 w-5" /> Quiero recibir avisos por WhatsApp
                            </a>
                        </Button>
                        <p className="mt-2 text-xs text-gray-500">
                            Se abre WhatsApp con el mensaje listo: solo tienes que enviarlo. Puedes darte de baja
                            cuando quieras escribiendo BAJA.
                        </p>
                    </section>
                )}

                {pagable && (
                    <section className="rounded-2xl bg-white p-5 text-center shadow-sm">
                        <h2 className="flex items-center justify-center gap-2 text-sm font-semibold text-gray-900">
                            <QrCode className="h-4 w-4" /> Abre este cobro en otro celular
                        </h2>
                        <div className="mt-3 inline-block rounded-lg bg-white p-2">
                            <QRCodeSVG value={`${window.location.origin}/p/${encodeURIComponent(token)}`} size={160} />
                        </div>
                        <p className="mt-1 text-xs text-gray-500">Escanéalo con la cámara.</p>
                    </section>
                )}

                <p className="text-center text-xs text-gray-500">
                    ¿Tienes cuenta? <a href="/my-payments" className="underline">Ver todos tus pagos</a>
                </p>
                <PieSportMaps />
            </div>
        </main>
    );
}

function BloqueSubirComprobante({ token, hayWhatsApp, onSubido }: {
    token: string; hayWhatsApp: boolean; onSubido: () => void;
}) {
    const [archivo, setArchivo] = useState<File | null>(null);
    const [subiendo, setSubiendo] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [listo, setListo] = useState<string | null>(null);

    async function enviar() {
        if (!archivo) return;
        setSubiendo(true);
        setError(null);
        try {
            const r = await subirComprobanteCobroPublico(token, archivo);
            setListo(r.estado === 'pagado'
                ? '¡Listo! La escuela ya aplicó tu pago.'
                : r.estado === 'rechazado'
                    ? 'No pudimos validar ese comprobante. Revisa que sea el de este pago o escríbele a la escuela.'
                    : 'Recibimos tu comprobante. La escuela lo revisa y lo aplica; no tienes que hacer nada más.');
            setArchivo(null);
            onSubido();
        } catch (e) {
            setError((e as Error).message || 'No pudimos subir el comprobante. Intenta de nuevo.');
        } finally {
            setSubiendo(false);
        }
    }

    return (
        <section className="rounded-2xl bg-white p-5 shadow-sm" data-testid="subir-comprobante">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Upload className="h-4 w-4" /> {hayWhatsApp ? 'O sube aquí el comprobante' : 'Sube tu comprobante'}
            </h2>
            <p className="mt-1 text-xs text-gray-600">
                Después de transferir, sube la captura o el PDF del comprobante. La escuela lo revisa y lo aplica a este cobro.
            </p>
            {listo ? (
                <p role="status" className="mt-3 flex items-start gap-2 text-sm text-green-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {listo}
                </p>
            ) : (
                <>
                    <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,application/pdf"
                        aria-label="Archivo del comprobante"
                        className="mt-3 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm"
                        onChange={(e) => { setArchivo(e.target.files?.[0] ?? null); setError(null); }}
                        disabled={subiendo}
                    />
                    <Button className="mt-3 h-12 w-full" onClick={enviar} disabled={!archivo || subiendo}>
                        {subiendo ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Enviar comprobante'}
                    </Button>
                    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
                </>
            )}
        </section>
    );
}

/** Línea enmascarada: "Cédula de ciudadanía terminada en 4050, correo ju•••@gmail.com". */
function resumenEnmascarado(r: ResumenFacturaPublica): string | null {
    if (!r.tieneDatos) return null;
    const tipo = esTipoDocumento(r.tipoDocumento) ? ETIQUETA_TIPO[r.tipoDocumento] : 'documento';
    return `${tipo} terminada en ${r.documentoTermina ?? '••••'}${r.correoEnmascarado ? `, correo ${r.correoEnmascarado}` : ''}`;
}

function BloqueFacturaPublica({ token }: { token: string }) {
    const [resumen, setResumen] = useState<ResumenFacturaPublica | null>(null);
    const ref = useRef<HTMLElement | null>(null);
    const desdeCorreo = typeof window !== 'undefined' && window.location.hash === '#factura';

    const recargar = useCallback(async () => {
        try {
            setResumen(await obtenerFacturaPublica(token));
        } catch {
            setResumen(null);   // sin bloque: la página de pago no depende de esto
        }
    }, [token]);

    useEffect(() => { void recargar(); }, [recargar]);

    // Llegó desde el correo («Completa tus datos aquí»): llevarlo al bloque.
    useEffect(() => {
        if (resumen?.disponible && desdeCorreo) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [resumen, desdeCorreo]);

    if (!resumen?.disponible || !resumen.pagador) return null;

    return (
        <section id="factura" ref={ref} className="rounded-2xl bg-white p-5 shadow-sm">
            <FacturaElectronicaPreferencia
                preferencia={resumen.preferencia}
                resumenGuardado={resumenEnmascarado(resumen)}
                abrirFormulario={desdeCorreo}
                onGuardar={async (datos) => {
                    try {
                        await guardarFacturaPublica(token, datos);
                        await recargar();
                        return null;
                    } catch (e) {
                        return (e as Error).message || 'No pudimos guardar tus datos. Intenta de nuevo.';
                    }
                }}
            />
        </section>
    );
}

/** "Con SportMaps" siempre visible: logo de la escuela ≠ marca blanca. */
function PieSportMaps() {
    return <p className="pt-2 text-center text-[11px] text-gray-400">Cobro gestionado con SportMaps</p>;
}
