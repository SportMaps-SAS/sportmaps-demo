import { useState } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Users, UserPlus, Baby, Loader2, ChevronRight, School, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { normalizeText } from '@/lib/normalizeText';
import { nombresParecidos } from '@/lib/nombreParecido';

interface ChildSelectorModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChildSelected: (childId: string, childName: string) => void;

    // Optional props - used in PendingEnrollment flow
    teamId?: string;
    teamName?: string;
    schoolId?: string;
    schoolName?: string;
    programName?: string;
}

interface Child {
    id: string;
    full_name: string;
    date_of_birth: string;
    grade: string | null;
}

/**
 * Calculates age from a date of birth string (YYYY-MM-DD format)
 * Handles invalid dates gracefully
 */
function computeAge(dob: string): number {
    try {
        const birth = new Date(dob);
        if (isNaN(birth.getTime())) return 0; // Invalid date

        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();

        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
            age--;
        }
        return age;
    } catch {
        return 0;
    }
}

// Mismo criterio que normalize_athlete_name() en la base: sin tildes, en
// minúsculas y con los espacios internos colapsados. Si el frontend normaliza
// distinto que la base, el aviso y el bloqueo real dejan de coincidir.
function normalizarNombre(valor: string): string {
    return normalizeText(valor).replace(/\s+/g, ' ');
}

/** Un nombre que el acudiente NO puede volver a crear, y de dónde viene. */
interface NombreTomado {
    nombre: string;
    /** Academia que ya cargó al atleta, cuando el nombre viene de una invitación. */
    academia?: string;
    origen: 'hijo' | 'invitacion';
}

export function ChildSelectorModal({
    open,
    onOpenChange,
    onChildSelected,
    teamId,
    teamName,
    schoolId,
    schoolName,
}: ChildSelectorModalProps) {
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
    const [showNewChildForm, setShowNewChildForm] = useState(false);
    const [newChildName, setNewChildName] = useState('');
    // El acudiente confirmó que el nombre parecido es OTRO hijo (no una errata).
    const [otroHijoConfirmado, setOtroHijoConfirmado] = useState(false);
    const [newChildDob, setNewChildDob] = useState('');

    // Fetch children using React Query
    const { data: children = [], isLoading } = useQuery({
        queryKey: ['my-children', user?.id],
        queryFn: async () => {
            if (!user) return [];

            const { data, error } = await supabase
                .from('children')
                .select('id, full_name, date_of_birth, grade')
                .eq('parent_id', user.id)
                .order('full_name');

            if (error) throw error;
            return data || [];
        },
        enabled: open && !!user,
    });

    // Con una invitación pendiente el atleta YA está cargado por la academia.
    // Volver a crearlo acá deja dos personas facturables para el mismo atleta.
    const { data: pendingInvitations = [], isLoading: isLoadingInvitations } = useQuery({
        queryKey: ['my-invitations', user?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('invitations')
                // Misma lista de campos que MyChildrenPage: comparten queryKey, así
                // que pedir distinto deja la caché con una forma u otra según quién
                // monte primero.
                .select('id, child_name, role_to_assign, schools(name)')
                .eq('email', user?.email ?? '')
                .eq('status', 'pending');

            if (error) throw error;
            return (data || []) as any[];
        },
        enabled: open && !!user?.email,
    });

    const nombresTomados: NombreTomado[] = [
        ...children.map((c) => ({ nombre: c.full_name, origen: 'hijo' as const })),
        ...pendingInvitations
            .filter((i) => i.child_name)
            .map((i) => ({
                nombre: i.child_name as string,
                academia: i.schools?.name as string | undefined,
                origen: 'invitacion' as const,
            })),
    ];

    function buscarNombreTomado(valor: string): NombreTomado | undefined {
        const candidato = normalizarNombre(valor);
        if (!candidato) return undefined;
        return nombresTomados.find((n) => normalizarNombre(n.nombre) === candidato);
    }

    function mensajeDuplicado(tomado: NombreTomado): string {
        if (tomado.origen === 'invitacion') {
            const academia = tomado.academia || 'la academia';
            return `${tomado.nombre} ya viene cargado por ${academia} en una invitación sin aceptar. Acepta la invitación en vez de crearlo de nuevo: si lo creas acá queda inscrito y cobrado dos veces. Si es OTRO hijo distinto, escribe su nombre completo.`;
        }
        return `${tomado.nombre} ya está en tu cuenta; selecciónalo de la lista en vez de crearlo de nuevo. Si es OTRO hijo distinto, escribe su nombre completo.`;
    }

    const nombreTomado = buscarNombreTomado(newChildName);
    // Errata de tipeo (Rodriguez / Rodruguez): no bloquea, pide confirmar que es otro hijo.
    const nombreParecido = nombreTomado
        ? undefined
        : nombresTomados.find((n) => nombresParecidos(n.nombre, newChildName));

    // Auto-select if only one child
    if (!selectedChildId && children.length === 1) {
        setSelectedChildId(children[0].id);
    }

    // Auto-show form if no children. Con invitación pendiente NO se auto-abre:
    // el camino correcto es aceptarla, no crear al atleta a mano.
    // Solo con el modal abierto: montado y cerrado, las consultas están apagadas
    // (children = []) y el formulario quedaba abierto, tapando la lista de hijos.
    if (
        open &&
        !showNewChildForm &&
        children.length === 0 &&
        !isLoading &&
        !isLoadingInvitations &&
        pendingInvitations.length === 0
    ) {
        setShowNewChildForm(true);
    }

    // Mutation to create child
    const createChildMutation = useMutation({
        mutationFn: async () => {
            if (!user || !newChildName.trim()) {
                throw new Error('El nombre del hijo es requerido');
            }

            // Este insert manda school_id, así que el trigger nuevo
            // (trg_guard_alta_manual_hijo_duplicado, solo para school_id NULL) lo
            // exime, y el viejo (trg_bloquear_atleta_duplicado) exige documento o
            // nombre + fecha de nacimiento idénticos contra otra fila de children
            // — nunca contra la ficha de unregistered_athletes ni contra la
            // invitación. Por esa costura, el único filtro real es este.
            const tomado = buscarNombreTomado(newChildName);
            if (tomado) {
                throw new Error(mensajeDuplicado(tomado));
            }

            // Sin fallback a hoy: una fecha inventada guarda un dato falso y
            // además desarma la rama nombre + fecha del trigger viejo.
            if (!newChildDob) {
                throw new Error('La fecha de nacimiento es requerida');
            }

            const { data, error } = await supabase
                .from('children')
                .insert({
                    full_name: newChildName.trim(),
                    date_of_birth: newChildDob,
                    parent_id: user.id,
                    school_id: schoolId as string,
                })
                .select('id, full_name, date_of_birth, grade')
                .single();

            if (error) throw error;
            return data;
        },
        onSuccess: (newChild) => {
            queryClient.invalidateQueries({ queryKey: ['my-children'] });
            setSelectedChildId(newChild.id);
            setShowNewChildForm(false);
            setNewChildName('');
            setNewChildDob('');
            toast.success(`${newChild.full_name} agregado correctamente`);
        },
        onError: (error: any) => {
            toast.error(error.message || 'Error al agregar hijo/a');
        },
    });

    function handleCreateChild(e: React.FormEvent) {
        e.preventDefault();
        if (nombreTomado || (nombreParecido && !otroHijoConfirmado)) return;
        createChildMutation.mutate();
    }

    function handleConfirm() {
        if (!selectedChildId) return;

        const child = children.find((c) => c.id === selectedChildId);
        if (child) {
            onChildSelected(child.id, child.full_name);
        }
    }

    const getInitials = (name: string) => {
        return name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .slice(0, 2)
            .toUpperCase();
    };

    // Build dialog description based on context
    const description = (() => {
        if (schoolName && teamName) {
            return `Selecciona al niño/a que participará en "${teamName}" en ${schoolName}.`;
        }
        if (teamName) {
            return `Selecciona al niño/a que participará en "${teamName}".`;
        }
        return 'Selecciona al hijo que quieres inscribir.';
    })();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-modal-sm">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-xl">
                        <Users className="h-5 w-5 text-primary" />
                        ¿Quién se inscribe?
                    </DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                {isLoading || isLoadingInvitations ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        {pendingInvitations.length > 0 && (
                            <div className="flex items-start gap-3 p-3 rounded-xl border border-primary/30 bg-primary/5">
                                <School className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                                <div className="text-xs">
                                    <p className="font-semibold text-sm">
                                        {pendingInvitations[0].schools?.name || 'Tu academia'} ya cargó a
                                        {pendingInvitations[0].child_name
                                            ? ` ${pendingInvitations[0].child_name}`
                                            : ' tu hijo/a'}
                                    </p>
                                    <p className="text-muted-foreground mt-1">
                                        Acepta la invitación desde tu inicio y aparecerá acá con su plan y su
                                        equipo. No lo registres a mano: quedaría inscrito y cobrado dos veces.
                                        Si tienes <strong>otro</strong> hijo/a que la academia no cargó, ese sí
                                        puedes agregarlo.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Existing children */}
                        {children.length > 0 && !showNewChildForm && (
                            <RadioGroup
                                value={selectedChildId || ''}
                                onValueChange={setSelectedChildId}
                                className="space-y-2"
                            >
                                {children.map((child) => (
                                    <label
                                        key={child.id}
                                        htmlFor={`child-${child.id}`}
                                        className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedChildId === child.id
                                                ? 'border-primary bg-primary/5 shadow-sm'
                                                : 'border-border hover:border-primary/40'
                                            }`}
                                    >
                                        <RadioGroupItem
                                            value={child.id}
                                            id={`child-${child.id}`}
                                            className="sr-only"
                                        />
                                        <Avatar className="h-10 w-10 bg-primary/10">
                                            <AvatarFallback className="bg-primary/10 text-primary font-bold text-sm">
                                                {getInitials(child.full_name)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-semibold text-sm">{child.full_name}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {child.date_of_birth
                                                    ? `${computeAge(child.date_of_birth)} años`
                                                    : ''}
                                                {child.date_of_birth && child.grade ? ' · ' : ''}
                                                {child.grade || ''}
                                            </p>
                                        </div>
                                        {selectedChildId === child.id && (
                                            <ChevronRight className="h-5 w-5 text-primary animate-in fade-in" />
                                        )}
                                    </label>
                                ))}
                            </RadioGroup>
                        )}

                        {/* New child form */}
                        {showNewChildForm && (
                            <form
                                onSubmit={handleCreateChild}
                                className="space-y-3 p-4 rounded-xl border-2 border-dashed bg-muted/30"
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <Baby className="h-4 w-4 text-primary" />
                                    <span className="text-sm font-semibold">Agregar hijo/a</span>
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="child-name" className="text-xs">
                                        Nombre completo
                                    </Label>
                                    <Input
                                        id="child-name"
                                        required
                                        placeholder="Ej. Sofía García"
                                        value={newChildName}
                                        onChange={(e) => { setNewChildName(e.target.value); setOtroHijoConfirmado(false); }}
                                        disabled={createChildMutation.isPending}
                                        aria-invalid={!!nombreTomado}
                                    />
                                    {nombreTomado && (
                                        <p className="flex items-start gap-1.5 text-xs text-destructive">
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                            <span>{mensajeDuplicado(nombreTomado)}</span>
                                        </p>
                                    )}
                                    {nombreParecido && (
                                        <label className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                            <span>
                                                Se parece a <strong>{nombreParecido.nombre}</strong>, que ya está en tu cuenta o en una invitación. Si es el mismo atleta, no lo crees de nuevo: se cobraría dos veces.
                                                <span className="mt-1 flex items-center gap-1.5 font-medium">
                                                    <input
                                                        type="checkbox"
                                                        checked={otroHijoConfirmado}
                                                        onChange={(e) => setOtroHijoConfirmado(e.target.checked)}
                                                        disabled={createChildMutation.isPending}
                                                    />
                                                    Es otro hijo/a distinto
                                                </span>
                                            </span>
                                        </label>
                                    )}
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="child-dob" className="text-xs">
                                        Fecha de nacimiento
                                    </Label>
                                    <Input
                                        id="child-dob"
                                        type="date"
                                        required
                                        max={todayColombia()}
                                        value={newChildDob}
                                        onChange={(e) => setNewChildDob(e.target.value)}
                                        disabled={createChildMutation.isPending}
                                    />
                                </div>
                                <div className="flex gap-2 pt-1">
                                    {(children.length > 0 || pendingInvitations.length > 0) && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setShowNewChildForm(false)}
                                            disabled={createChildMutation.isPending}
                                        >
                                            Cancelar
                                        </Button>
                                    )}
                                    <Button
                                        type="submit"
                                        size="sm"
                                        disabled={createChildMutation.isPending || !!nombreTomado || (!!nombreParecido && !otroHijoConfirmado)}
                                        className="flex-1"
                                    >
                                        {createChildMutation.isPending ? (
                                            <>
                                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                                Guardando...
                                            </>
                                        ) : (
                                            'Agregar'
                                        )}
                                    </Button>
                                </div>
                            </form>
                        )}

                        {/* Button to add another child (when not showing form) */}
                        {!showNewChildForm && (children.length > 0 || pendingInvitations.length > 0) && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full border-dashed"
                                onClick={() => setShowNewChildForm(true)}
                            >
                                <UserPlus className="h-4 w-4 mr-2" />
                                Agregar otro hijo/a
                            </Button>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        onClick={handleConfirm}
                        disabled={
                            !selectedChildId || showNewChildForm || isLoading || isLoadingInvitations
                        }
                        className="w-full"
                    >
                        Continuar inscripción
                        <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
