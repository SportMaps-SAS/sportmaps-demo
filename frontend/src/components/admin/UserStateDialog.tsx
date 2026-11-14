/**
 * UserStateDialog — Panel de diagnóstico de soporte (F0).
 * Spec: docs/specs/consola-de-soporte-super-admin.md §3
 *
 * Responde "¿esta persona puede entrar?" sin abrir la base ni correr scripts.
 * Solo lectura: no ofrece ninguna acción todavía, y "eliminar cuenta" no va a
 * existir aquí — es lo que el usuario pide y casi nunca lo que necesita.
 *
 * El veredicto va arriba y en una línea, porque el error del incidente que
 * originó esto no fue técnico: fue que nadie podía *ver* que la cuenta ya
 * estaba bien.
 */

import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Loader2, Search, ShieldCheck, ShieldAlert, ShieldX,
    KeyRound, Building2, Copy, UsersRound, AlertTriangle,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';

// ─── Tipos (espejo de bff/src/services/support-diagnosis.service.ts) ──────────

interface UserState {
    query: { email: string | null; userId: string | null };
    access: {
        found: boolean;
        userId: string | null;
        email: string | null;
        emailConfirmedAt: string | null;
        lastSignInAt: string | null;
        bannedUntil: string | null;
        providers: string[];
        recoverySentAt: string | null;
        createdAt: string | null;
        otherAuthAccounts: Array<{ id: string; email: string | null; lastSignInAt: string | null }>;
        similarEmails: Array<{ source: string; email: string; label: string | null }>;
    };
    membership: {
        profile: { id: string; fullName: string | null; email: string | null; phone: string | null; role: string | null; docNumber: string | null; dateOfBirth: string | null } | null;
        schoolMembers: Array<{ id: string; schoolId: string; schoolName: string | null; role: string; status: string; joinedAt: string | null }>;
        enrollments: Array<{ id: string; schoolId: string; schoolName: string | null; subject: string; teamId: string | null; monthlyFee: number | null; status: string; createdAt: string | null }>;
        invitations: Array<{ id: string; schoolId: string; schoolName: string | null; email: string; status: string; roleToAssign: string | null; childName: string | null; monthlyFee: number | null; createdAt: string | null; expiresAt: string | null }>;
        schoolAthletes: Array<{ id: string; schoolId: string; fullName: string | null; isActive: boolean | null; enrollmentStatus: string | null; teamId: string | null; priceMonthly: number | null }>;
    };
    duplicity: {
        unregisteredAthletes: Array<{ id: string; schoolId: string; fullName: string | null; docNumber: string | null; isActive: boolean | null; linkedProfileId: string | null }>;
        children: Array<{ id: string; fullName: string | null; parentId: string | null; parentEmailTemp: string | null; docNumber: string | null; schoolId: string | null }>;
        activeEnrollmentCount: number;
        repeatedEnrollmentGroups: number;
        duplicatePaymentGroups: Array<{ schoolId: string; period: string; amount: number; paymentIds: string[] }>;
        paymentsWithoutPayer: number;
    };
    verdict: {
        level: 'ok' | 'warn' | 'error';
        headline: string;
        findings: string[];
        recommendedAction: string;
    };
    generatedAt: string;
}

// ─── Presentación ─────────────────────────────────────────────────────────────

const VERDICT_STYLE: Record<UserState['verdict']['level'], { box: string; Icon: typeof ShieldCheck }> = {
    ok:    { box: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100', Icon: ShieldCheck },
    warn:  { box: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100', Icon: ShieldAlert },
    error: { box: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100', Icon: ShieldX },
};

// Se nombra la acción, no el botón: F1/F2 todavía no existen, así que esto es
// una recomendación para el humano, no un atajo clicable.
const ACTION_LABEL: Record<string, string> = {
    ninguna: 'No hay nada que hacer sobre la cuenta.',
    confirmar_correo: 'Acción sugerida: confirmar el correo manualmente.',
    reenviar_enlace: 'Acción sugerida: reenviar el enlace de acceso.',
    revisar_correo_similar: 'Acción sugerida: revisar si se registró con otro correo (typo).',
    revincular_escuela: 'Acción sugerida: revincular a la escuela (no reusar la invitación).',
    fusionar_identidades: 'Acción sugerida: fusionar las identidades duplicadas.',
    revisar_cobros: 'Acción sugerida: revisar los cobros antes de responderle.',
};

function fmt(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-CO', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });
}

function money(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return `$${Number(n).toLocaleString('es-CO')}`;
}

function Row({ label, children, bad }: { label: string; children: React.ReactNode; bad?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
            <span className="text-muted-foreground shrink-0">{label}</span>
            <span className={`text-right ${bad ? 'font-medium text-destructive' : ''}`}>{children}</span>
        </div>
    );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof KeyRound; children: React.ReactNode }) {
    return (
        <section className="space-y-1">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4 text-muted-foreground" />
                {title}
            </h3>
            <div className="rounded-md border p-3">{children}</div>
        </section>
    );
}

const STATUS_TONE: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    accepted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    cancelled: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    expired: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

function StatusBadge({ value }: { value: string }) {
    return (
        <Badge variant="outline" className={`text-xs ${STATUS_TONE[value] || ''}`}>
            {value}
        </Badge>
    );
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Correo precargado (el de la fila desde la que se abrió). */
    initialEmail?: string;
}

export default function UserStateDialog({ open, onOpenChange, initialEmail }: Props) {
    const [email, setEmail] = useState(initialEmail ?? '');
    const [state, setState] = useState<UserState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(async (target: string) => {
        const clean = target.trim();
        if (!clean) return;
        setLoading(true);
        setError(null);
        try {
            const data = await bffClient.get<UserState>(
                `/api/v1/admin/support/user-state?email=${encodeURIComponent(clean)}`,
            );
            setState(data);
        } catch (err: any) {
            // Un error NO puede quedarse en silencio dejando el panel vacío: en
            // soporte eso se lee como "no hay nada raro" y es justo lo contrario.
            setState(null);
            setError(err?.message || 'No se pudo obtener el diagnóstico.');
        } finally {
            setLoading(false);
        }
    }, []);

    // Al abrir con un correo de la tabla, diagnosticar de una.
    useEffect(() => {
        if (!open) return;
        setEmail(initialEmail ?? '');
        setState(null);
        setError(null);
        if (initialEmail) void run(initialEmail);
    }, [open, initialEmail, run]);

    const copy = (text: string) => {
        void navigator.clipboard.writeText(text);
        toast({ title: 'Copiado', description: text });
    };

    const V = state ? VERDICT_STYLE[state.verdict.level] : null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Diagnóstico de la cuenta</DialogTitle>
                    <DialogDescription>
                        Solo lectura. Muestra si la persona puede entrar, dónde está inscrita y si su
                        identidad quedó partida en dos.
                    </DialogDescription>
                </DialogHeader>

                <form
                    className="flex gap-2"
                    onSubmit={(e) => { e.preventDefault(); void run(email); }}
                >
                    <Input
                        placeholder="correo@dominio.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="off"
                    />
                    <Button type="submit" disabled={loading || !email.trim()} className="gap-2 shrink-0">
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                        Diagnosticar
                    </Button>
                </form>

                {error && (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {state && V && (
                    <ScrollArea className="max-h-[60vh] pr-3">
                        <div className="space-y-4">
                            {/* Bloque D — el veredicto va primero, a propósito. */}
                            <div className={`rounded-lg border p-3 ${V.box}`}>
                                <div className="flex items-center gap-2 font-semibold">
                                    <V.Icon className="h-5 w-5 shrink-0" />
                                    {state.verdict.headline}
                                </div>
                                <ul className="mt-2 space-y-1 pl-7 text-sm">
                                    {state.verdict.findings.map((f, i) => (
                                        <li key={i} className="list-disc">{f}</li>
                                    ))}
                                </ul>
                                <p className="mt-2 pl-7 text-sm font-medium">
                                    {ACTION_LABEL[state.verdict.recommendedAction] ?? state.verdict.recommendedAction}
                                </p>
                            </div>

                            {/* Bloque A — acceso */}
                            <Section title="Acceso" icon={KeyRound}>
                                {!state.access.found ? (
                                    <p className="text-sm text-muted-foreground">
                                        No existe cuenta de auth para ese correo.
                                    </p>
                                ) : (
                                    <>
                                        <Row label="Correo">
                                            <span className="inline-flex items-center gap-1">
                                                {state.access.email}
                                                <Button
                                                    type="button" variant="ghost" size="icon" className="h-5 w-5"
                                                    onClick={() => copy(state.access.email ?? '')}
                                                >
                                                    <Copy className="h-3 w-3" />
                                                </Button>
                                            </span>
                                        </Row>
                                        <Row label="Correo confirmado" bad={!state.access.emailConfirmedAt}>
                                            {state.access.emailConfirmedAt ? fmt(state.access.emailConfirmedAt) : 'NO — el login lo rechaza'}
                                        </Row>
                                        <Row label="Último ingreso" bad={!state.access.lastSignInAt}>
                                            {state.access.lastSignInAt ? fmt(state.access.lastSignInAt) : 'Nunca ha entrado'}
                                        </Row>
                                        <Row label="Proveedores">
                                            {state.access.providers.length ? state.access.providers.join(', ') : 'solo contraseña'}
                                        </Row>
                                        <Row label="Recuperación enviada">{fmt(state.access.recoverySentAt)}</Row>
                                        <Row label="Bloqueo administrativo" bad={!!state.access.bannedUntil}>
                                            {state.access.bannedUntil ?? 'ninguno'}
                                        </Row>
                                        <Row label="user_id">
                                            <code className="text-xs">{state.access.userId}</code>
                                        </Row>

                                        {state.access.otherAuthAccounts.length > 0 && (
                                            <>
                                                <Separator className="my-2" />
                                                <p className="text-xs font-medium text-destructive">
                                                    Otras cuentas de auth con correo parecido:
                                                </p>
                                                {state.access.otherAuthAccounts.map(a => (
                                                    <Row key={a.id} label={a.email ?? a.id}>
                                                        último ingreso {a.lastSignInAt ? fmt(a.lastSignInAt) : 'nunca'}
                                                    </Row>
                                                ))}
                                            </>
                                        )}

                                        {state.access.similarEmails.length > 0 && (
                                            <>
                                                <Separator className="my-2" />
                                                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                                                    Correos parecidos (un typo no se arregla con un reset):
                                                </p>
                                                {state.access.similarEmails.map((s, i) => (
                                                    <Row key={i} label={`${s.email} · ${s.source}`}>{s.label ?? '—'}</Row>
                                                ))}
                                            </>
                                        )}
                                    </>
                                )}
                            </Section>

                            {/* Bloque B — pertenencia */}
                            <Section title="Pertenencia" icon={Building2}>
                                {state.membership.profile ? (
                                    <>
                                        <Row label="Nombre">{state.membership.profile.fullName ?? '—'}</Row>
                                        <Row label="Rol">{state.membership.profile.role ?? '—'}</Row>
                                        <Row label="Documento">{state.membership.profile.docNumber ?? '—'}</Row>
                                        <Row label="Teléfono">{state.membership.profile.phone ?? '—'}</Row>
                                    </>
                                ) : (
                                    <p className="text-sm text-muted-foreground">Sin perfil en `profiles`.</p>
                                )}

                                <Separator className="my-2" />
                                <p className="mb-1 text-xs font-medium text-muted-foreground">
                                    Membresías ({state.membership.schoolMembers.length})
                                </p>
                                {state.membership.schoolMembers.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Ninguna.</p>
                                ) : state.membership.schoolMembers.map(m => (
                                    <Row key={m.id} label={m.schoolName ?? m.schoolId}>
                                        {m.role} · <StatusBadge value={m.status} />
                                    </Row>
                                ))}

                                <Separator className="my-2" />
                                <p className="mb-1 text-xs font-medium text-muted-foreground">
                                    Inscripciones ({state.membership.enrollments.length})
                                </p>
                                {state.membership.enrollments.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Ninguna.</p>
                                ) : state.membership.enrollments.map(e => (
                                    <Row key={e.id} label={`${e.schoolName ?? e.schoolId} · ${e.subject}`}>
                                        <StatusBadge value={e.status} />{' '}
                                        {money(e.monthlyFee)} {e.teamId ? '' : '· sin equipo'}
                                    </Row>
                                ))}

                                <Separator className="my-2" />
                                <p className="mb-1 text-xs font-medium text-muted-foreground">
                                    Invitaciones ({state.membership.invitations.length})
                                </p>
                                {state.membership.invitations.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Ninguna.</p>
                                ) : state.membership.invitations.map(i => (
                                    <Row key={i.id} label={`${i.schoolName ?? i.schoolId} · ${i.roleToAssign ?? '—'}`}>
                                        <StatusBadge value={i.status} /> {fmt(i.createdAt)}
                                    </Row>
                                ))}

                                <Separator className="my-2" />
                                <p className="mb-1 text-xs font-medium text-muted-foreground">
                                    En school_athletes — lo que la escuela ve y factura ({state.membership.schoolAthletes.length})
                                </p>
                                {state.membership.schoolAthletes.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">No aparece.</p>
                                ) : state.membership.schoolAthletes.map(s => (
                                    <Row key={s.id} label={s.fullName ?? s.id}>
                                        {s.isActive ? 'activo' : 'inactivo'} · {s.enrollmentStatus ?? '—'} · {money(s.priceMonthly)}
                                    </Row>
                                ))}
                            </Section>

                            {/* Bloque C — duplicidad */}
                            <Section title="Duplicidad" icon={UsersRound}>
                                <Row
                                    label="Inscripciones activas"
                                    bad={state.duplicity.repeatedEnrollmentGroups > 0}
                                >
                                    {state.duplicity.activeEnrollmentCount}
                                </Row>
                                <Row
                                    label="Cobros de menor sin pagador"
                                    bad={state.duplicity.paymentsWithoutPayer > 0}
                                >
                                    {state.duplicity.paymentsWithoutPayer}
                                </Row>
                                <Row
                                    label="Grupos de cobro duplicado"
                                    bad={state.duplicity.duplicatePaymentGroups.length > 0}
                                >
                                    {state.duplicity.duplicatePaymentGroups.length}
                                </Row>
                                {state.duplicity.duplicatePaymentGroups.map((g, i) => (
                                    <Row key={i} label={`${g.period} · ${money(g.amount)}`}>
                                        {g.paymentIds.length} cobros
                                    </Row>
                                ))}

                                <Separator className="my-2" />
                                <p className="mb-1 text-xs font-medium text-muted-foreground">
                                    Registros precargados por la escuela ({state.duplicity.unregisteredAthletes.length})
                                </p>
                                {state.duplicity.unregisteredAthletes.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Ninguno.</p>
                                ) : state.duplicity.unregisteredAthletes.map(u => (
                                    <Row
                                        key={u.id}
                                        label={u.fullName ?? u.id}
                                        bad={!!u.isActive && !u.linkedProfileId}
                                    >
                                        {u.linkedProfileId ? 'vinculado' : 'SIN VINCULAR'} · {u.isActive ? 'activo' : 'inactivo'}
                                    </Row>
                                ))}

                                {state.duplicity.children.length > 0 && (
                                    <>
                                        <Separator className="my-2" />
                                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                                            Menores a cargo ({state.duplicity.children.length})
                                        </p>
                                        {state.duplicity.children.map(k => (
                                            <Row key={k.id} label={k.fullName ?? k.id} bad={!k.parentId}>
                                                {k.parentId ? 'con acudiente' : 'parent_id NULL'}
                                            </Row>
                                        ))}
                                    </>
                                )}
                            </Section>

                            <p className="text-right text-xs text-muted-foreground">
                                Generado {fmt(state.generatedAt)} · solo lectura
                            </p>
                        </div>
                    </ScrollArea>
                )}
            </DialogContent>
        </Dialog>
    );
}
