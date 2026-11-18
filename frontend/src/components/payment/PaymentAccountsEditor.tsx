/**
 * <PaymentAccountsEditor> — lista de llaves de pago de la escuela.
 *
 * Reemplaza a los cuatro inputs sueltos (Nequi / Daviplata / Bre-B / Llave de
 * transferencia) que solo admitian un valor por canal. Lo que se registre aca es
 * lo que ve el acudiente en su modal de pago y lo que el OCR acepta como destino
 * valido del comprobante, asi que una llave apagada o borrada deja de valer en
 * ambos lados.
 *
 * Los valores se muestran enmascarados hasta que el admin pulsa "Mostrar" (mismo
 * gesto que el resto de la tarjeta). Mientras esten enmascarados el input es de
 * solo lectura: si se pudiera escribir encima, se guardarian los asteriscos.
 *
 * Tipo «Link de pago (Wompi)» (2026-10-06, Dynasty): no es una llave para
 * transferir sino un link reutilizable donde el acudiente escribe el valor. Se
 * muestra como botón en el checkout, la página /p/:token, el correo del estado
 * de cuenta y el bot. Va sin enmascarar (es una URL pública) y se valida https.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2 } from 'lucide-react';
import { maskSensitive } from '@/lib/utils';
import {
    PAYMENT_ACCOUNT_TYPES,
    accountPlaceholder,
    isPaymentLink,
    isValidPaymentLinkUrl,
    newAccountId,
    type PaymentAccount,
    type PaymentAccountType,
} from '@/lib/payment-accounts';

interface Props {
    accounts: PaymentAccount[];
    onChange: (next: PaymentAccount[]) => void;
    /** Compartido con la tarjeta: el botón "Mostrar" destapa todo de una vez. */
    showSensitive: boolean;
    onReveal: () => void;
}

const SELECT_CLS =
    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function PaymentAccountsEditor({ accounts, onChange, showSensitive, onReveal }: Props) {
    const patch = (id: string, changes: Partial<PaymentAccount>) =>
        onChange(accounts.map(a => (a.id === id ? { ...a, ...changes } : a)));

    const remove = (id: string) => onChange(accounts.filter(a => a.id !== id));

    const add = () =>
        onChange([
            ...accounts,
            { id: newAccountId(), type: 'breb', label: '', value: '', active: true },
        ]);

    return (
        <div className="space-y-3">
            <div>
                <Label className="font-medium">Llaves de transferencia</Label>
                <p className="text-xs text-muted-foreground max-w-[62ch]">
                    Bre-B, Nequi, Daviplata o llaves de otros bancos. Los acudientes las verán en
                    este orden, y solo se aceptan comprobantes girados a alguna de ellas. Si tienes un
                    link de pago de Wompi o Bold, agrégalo como «Link de pago»: los acudientes lo verán
                    como botón para pagar en línea.
                </p>
            </div>

            {accounts.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                    Sin llaves registradas. Los acudientes solo verán la cuenta bancaria.
                </p>
            ) : (
                <>
                    <div className="hidden md:grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,1.1fr)_4.5rem_2.5rem] gap-2 px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                        <span>Tipo</span>
                        <span>Etiqueta</span>
                        <span>Valor</span>
                        <span className="text-center">Visible</span>
                        <span className="sr-only">Acciones</span>
                    </div>

                    <div className="space-y-2">
                        {accounts.map(account => {
                            const link = isPaymentLink(account);
                            // Un link es una URL pública: no hay nada que enmascarar.
                            const visible = showSensitive || link;
                            const linkInvalido = link && account.value.trim() !== '' && !isValidPaymentLinkUrl(account.value);
                            return (
                            <div
                                key={account.id}
                                className={`grid grid-cols-1 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,1.1fr)_4.5rem_2.5rem] gap-2 items-center rounded-lg border bg-muted/30 p-2 ${account.active ? '' : 'opacity-60'}`}
                            >
                                <select
                                    className={SELECT_CLS}
                                    aria-label="Tipo de llave"
                                    value={account.type}
                                    onChange={e => patch(account.id, { type: e.target.value as PaymentAccountType })}
                                >
                                    {PAYMENT_ACCOUNT_TYPES.map(t => (
                                        <option key={t.value} value={t.value}>{t.label}</option>
                                    ))}
                                </select>

                                <Input
                                    aria-label="Etiqueta de la llave"
                                    placeholder="Ej: Bre-B principal"
                                    value={account.label}
                                    onChange={e => patch(account.id, { label: e.target.value })}
                                />

                                <Input
                                    aria-label={link ? 'Dirección del link de pago' : 'Valor de la llave'}
                                    aria-invalid={linkInvalido || undefined}
                                    type={link ? 'url' : 'text'}
                                    inputMode={link ? 'url' : undefined}
                                    placeholder={accountPlaceholder(account.type)}
                                    value={visible ? account.value : maskSensitive(account.value)}
                                    readOnly={!visible}
                                    className={linkInvalido ? 'border-destructive' : undefined}
                                    onFocus={() => { if (!visible) onReveal(); }}
                                    onChange={e => patch(account.id, { value: e.target.value })}
                                />

                                <div className="flex items-center gap-2 md:justify-center">
                                    <Switch
                                        checked={account.active}
                                        onCheckedChange={v => patch(account.id, { active: v })}
                                        aria-label="Mostrar esta llave a los acudientes"
                                    />
                                    <span className="text-xs text-muted-foreground md:hidden">
                                        {account.active ? 'Visible' : 'Oculta'}
                                    </span>
                                </div>

                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-9 w-9 justify-self-start md:justify-self-center text-muted-foreground hover:text-destructive"
                                    aria-label="Eliminar llave"
                                    onClick={() => remove(account.id)}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>

                                {/* Llave solo para inscripciones (only_for). Caso Dynasty
                                    2026-10-05: Nequi personal de la dueña donde se pagan
                                    SOLO las inscripciones. Con esto el acudiente no la ve al
                                    pagar la mensualidad, el bot no la ofrece y un comprobante
                                    de mensualidad girado ahí queda en revisión. */}
                                {linkInvalido && (
                                    <p className="md:col-span-5 px-1 text-xs text-destructive">
                                        Debe ser una dirección https completa, por ejemplo https://checkout.wompi.co/l/…
                                    </p>
                                )}
                                {link && !linkInvalido && (
                                    <p className="md:col-span-5 px-1 text-xs text-muted-foreground">
                                        El acudiente escribe el valor en Wompi: le pediremos mandar el comprobante para que
                                        apliques el pago.
                                    </p>
                                )}

                                <label className="md:col-span-5 flex items-start gap-2 px-1 text-xs text-muted-foreground cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 h-3.5 w-3.5 accent-primary"
                                        checked={!!account.only_for?.includes('inscripcion')}
                                        onChange={e => patch(account.id, { only_for: e.target.checked ? ['inscripcion'] : undefined })}
                                    />
                                    <span>
                                        Solo para inscripciones: no se muestra para pagar mensualidades ni la ofrece el
                                        asistente de WhatsApp.
                                    </span>
                                </label>
                            </div>
                            );
                        })}
                    </div>
                </>
            )}

            <Button variant="outline" size="sm" className="gap-2 border-dashed" onClick={add}>
                <Plus className="h-4 w-4" />
                Agregar llave
            </Button>
        </div>
    );
}
