/**
 * SupportChatModal — soporte in-app S0+S1 (MOD-21).
 *
 * Un solo hilo persistente (spec `docs/specs/soporte-in-app-chat-y-bot.md` §5):
 * se abre y está la historia completa, nunca un chat en blanco. El primer
 * mensaje del usuario abre el ticket (`POST /support/open`), los siguientes
 * van directo a `POST /support/messages` — el bot responde en la misma
 * request cuando puede, o el humano lo hace después (S0 siempre funciona,
 * el bot es una optimización encima, nunca un bloqueante).
 */
import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Send, User, Loader2, Headset, ThumbsUp, ThumbsDown } from "lucide-react";
import { MapiAvatar } from "@/components/brand/MapiAvatar";
import { bffClient } from "@/lib/api/bffClient";
import { respuestaACalificar, type Feedback } from "./teSirvio";

// El bot no manda markdown, pero SI puede citar un link de un artículo de
// ayuda (/ayuda/slug) dentro del texto — sin esto quedaría como texto plano
// sin poder tocarlo. Partimos el body en pedazos y solo el pedazo /ayuda/...
// se vuelve un <Link> de router (navegación SPA, no recarga completa).
//
// Mapi sí usa **negrita** para los nombres de menús y botones (así lo pide su
// prompt) y a veces envuelve el link como [texto](/ayuda/slug): se deja solo la
// ruta y la negrita se dibuja, para que no queden asteriscos ni corchetes sueltos.
const HELP_LINK_RE = /(\/ayuda\/[a-z0-9-]+|\*\*[^*\n]+\*\*)/g;
const MD_HELP_LINK_RE = /\[[^\]\n]*\]\((\/ayuda\/[a-z0-9-]+)\)/g;

function MessageBody({ body }: { body: string }) {
    // split() con grupo de captura intercala texto plano y coincidencias en
    // orden — los índices impares son SIEMPRE lo que matcheó el grupo, sin
    // volver a testear el regex (evita el gotcha de estado de un regex /g).
    const parts = body.replace(MD_HELP_LINK_RE, '$1').split(HELP_LINK_RE);
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1 && part.startsWith('**') ? (
                    <strong key={i}>{part.slice(2, -2)}</strong>
                ) : i % 2 === 1 ? (
                    <Link
                        key={i}
                        to={part}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline font-medium text-primary hover:opacity-80"
                    >
                        Ver el paso a paso completo →
                    </Link>
                ) : (
                    <span key={i}>{part}</span>
                )
            )}
        </>
    );
}

interface SupportMessage {
    id: string;
    author_type: "user" | "bot" | "agent";
    body: string;
    created_at: string;
}

interface SupportTicket {
    id: string;
    status: string;
    subject: string | null;
    category: string | null;
}

interface ThreadResponse {
    ticket: SupportTicket | null;
    messages: SupportMessage[];
    feedback?: Feedback;
}

interface SupportChatModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
    open: { label: "Mapi", className: "bg-primary/10 text-primary" },
    bot_handled: { label: "Mapi", className: "bg-primary/10 text-primary" },
    waiting_human: { label: "Esperando a soporte", className: "bg-amber-500/10 text-amber-600" },
    waiting_user: { label: "Te respondieron", className: "bg-emerald-500/10 text-emerald-600" },
    resolved: { label: "Resuelto", className: "bg-muted text-muted-foreground" },
    closed: { label: "Resuelto", className: "bg-muted text-muted-foreground" },
};

export function SupportChatModal({ isOpen, onClose }: SupportChatModalProps) {
    const [ticket, setTicket] = useState<SupportTicket | null>(null);
    const [messages, setMessages] = useState<SupportMessage[]>([]);
    const [input, setInput] = useState("");
    const [loadingThread, setLoadingThread] = useState(false);
    const [sending, setSending] = useState(false);
    const [feedback, setFeedback] = useState<Feedback>({});
    const [calificando, setCalificando] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setLoadingThread(true);
        bffClient
            .get<ThreadResponse>("/api/v1/support/thread")
            .then((res) => {
                setTicket(res.ticket);
                setMessages(res.messages);
                setFeedback(res.feedback ?? {});
            })
            .catch(() => {
                // Sin hilo previo o error de red: arranca en blanco, el primer
                // mensaje del usuario lo crea igual (POST /open).
                setTicket(null);
                setMessages([]);
                setFeedback({});
            })
            .finally(() => setLoadingThread(false));
    }, [isOpen]);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages, sending]);

    useEffect(() => {
        if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
    }, [isOpen]);

    const send = async () => {
        const body = input.trim();
        if (!body || sending) return;
        setInput("");
        setSending(true);

        // Optimista: el usuario ve su mensaje de inmediato.
        const optimistic: SupportMessage = {
            id: `optimistic-${Date.now()}`,
            author_type: "user",
            body,
            created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);

        try {
            let activeTicketId = ticket?.id;
            if (!activeTicketId) {
                const opened = await bffClient.post<{ ticket: SupportTicket }>("/api/v1/support/open", {});
                activeTicketId = opened.ticket.id;
                setTicket(opened.ticket);
            }

            const res = await bffClient.post<ThreadResponse>(
                "/api/v1/support/messages",
                { ticketId: activeTicketId, body },
            );
            setMessages(res.messages);
            if (res.ticket) setTicket(res.ticket);
            if (res.feedback) setFeedback(res.feedback);
        } catch (err) {
            // El mensaje optimista queda, pero se marca el error sin perder lo escrito.
            setMessages((prev) => [
                ...prev,
                {
                    id: `error-${Date.now()}`,
                    author_type: "bot",
                    body: "No pude enviar tu mensaje — revisa tu conexión e intenta de nuevo.",
                    created_at: new Date().toISOString(),
                },
            ]);
        } finally {
            setSending(false);
        }
    };

    // «¿Te sirvió?» — «No» pasa el caso a una persona (el BFF cambia el estado,
    // Mapi lo dice en el chat y sale el correo [Revisar] a SportMaps).
    const calificar = async (messageId: string, util: boolean) => {
        if (!ticket || calificando) return;
        setCalificando(true);
        setFeedback((prev) => ({ ...prev, [messageId]: util ? "si" : "no" }));
        try {
            const res = await bffClient.post<ThreadResponse>("/api/v1/support/feedback", {
                ticketId: ticket.id,
                messageId,
                util,
            });
            setMessages(res.messages);
            if (res.ticket) setTicket(res.ticket);
            if (res.feedback) setFeedback(res.feedback);
        } catch {
            // Sin guardar: se vuelven a mostrar los botones para reintentar.
            setFeedback((prev) => {
                const resto = { ...prev };
                delete resto[messageId];
                return resto;
            });
        } finally {
            setCalificando(false);
        }
    };

    const aCalificar = respuestaACalificar(messages, ticket?.status);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    const chip = STATUS_CHIP[ticket?.status ?? "open"] ?? STATUS_CHIP.open;

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-lg h-[37.5rem] max-h-sheet flex flex-col p-0 gap-0 overflow-hidden">
                {/* pr-12: deja libre la X de cerrar, que tapaba la etiqueta de estado. */}
                <DialogHeader className="pl-4 pr-12 py-3 border-b bg-muted/40">
                    <DialogTitle className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <MapiAvatar className="w-10 h-10" />
                            <div className="text-left">
                                <span className="text-base font-semibold">Mapi · Soporte SportMaps</span>
                                <p className="text-xs text-muted-foreground font-normal">Un solo chat, siempre la misma conversación</p>
                            </div>
                        </div>
                        <Badge className={`${chip.className} border-0 shrink-0`}>{chip.label}</Badge>
                    </DialogTitle>
                </DialogHeader>

                <ScrollArea className="flex-1 px-4" ref={scrollRef}>
                    <div className="py-4 space-y-4">
                        {loadingThread && (
                            <div className="flex justify-center py-8">
                                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                        )}

                        {!loadingThread && messages.length === 0 && (
                            <div className="flex gap-3 justify-start">
                                <BotAvatar />
                                <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm bg-muted">
                                    ¡Hola! 👋 Soy Mapi, el asistente de IA de SportMaps. Cuéntame qué necesitas y te ayudo, o te paso con una persona del equipo si hace falta.
                                </div>
                            </div>
                        )}

                        {messages.map((m) => (
                            <div key={m.id} className={`flex gap-3 ${m.author_type === "user" ? "justify-end" : "justify-start"}`}>
                                {m.author_type !== "user" && <BotAvatar isAgent={m.author_type === "agent"} />}
                                <div className="max-w-[80%] min-w-0">
                                    <div
                                        className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                                            m.author_type === "user"
                                                ? "bg-primary text-primary-foreground rounded-br-md"
                                                : "bg-muted rounded-bl-md"
                                        }`}
                                    >
                                        <MessageBody body={m.body} />
                                    </div>
                                    {m.id === aCalificar && (
                                        <TeSirvio
                                            valor={feedback[m.id]}
                                            disabled={calificando || sending}
                                            onCalificar={(util) => calificar(m.id, util)}
                                        />
                                    )}
                                </div>
                                {m.author_type === "user" && (
                                    <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                                        <User className="w-4 h-4 text-primary" />
                                    </div>
                                )}
                            </div>
                        ))}

                        {sending && (
                            <div className="flex gap-3 justify-start">
                                <BotAvatar />
                                <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-2.5">
                                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        Escribiendo...
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </ScrollArea>

                <div className="p-4 border-t bg-muted/30">
                    <div className="flex gap-2">
                        <Input
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Escribe tu mensaje..."
                            disabled={sending}
                            className="flex-1 bg-background"
                        />
                        <Button onClick={send} disabled={!input.trim() || sending} size="icon">
                            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TeSirvio({
    valor,
    disabled,
    onCalificar,
}: {
    valor?: "si" | "no";
    disabled: boolean;
    onCalificar: (util: boolean) => void;
}) {
    if (valor === "si") {
        return <p className="mt-1 px-1 text-xs text-muted-foreground">¡Qué bien! Gracias por contarme.</p>;
    }
    if (valor === "no") return null; // Mapi responde con su propio mensaje
    return (
        <div className="mt-1.5 flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span>¿Te sirvió?</span>
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-3 text-xs"
                disabled={disabled}
                onClick={() => onCalificar(true)}
            >
                <ThumbsUp className="h-3.5 w-3.5" /> Sí
            </Button>
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-3 text-xs"
                disabled={disabled}
                onClick={() => onCalificar(false)}
            >
                <ThumbsDown className="h-3.5 w-3.5" /> No
            </Button>
        </div>
    );
}

function BotAvatar({ isAgent = false }: { isAgent?: boolean }) {
    if (!isAgent) return <MapiAvatar />;
    return (
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
            <Headset className="w-4 h-4 text-primary-foreground" />
        </div>
    );
}
