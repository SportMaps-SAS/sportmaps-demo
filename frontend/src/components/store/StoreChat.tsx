/**
 * StoreChat — hilo de conversación de tienda (comprador ↔ vendedor).
 *
 * Reutilizable por ambos lados. Lee/escribe `store_messages` directo por
 * supabase (RLS por participantes). Al abrir, resetea los no-leídos del lado
 * que mira. Dominio aparte de los mensajes internos de escuela.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Send } from 'lucide-react';

interface StoreMessage {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export function StoreChat({
  conversationId,
  viewerRole,
}: {
  conversationId: string;
  viewerRole: 'buyer' | 'vendor';
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<StoreMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('store_messages')
      .select('id, sender_id, body, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    setMessages((data as StoreMessage[]) ?? []);
    setLoading(false);
  }, [conversationId]);

  // Resetea no-leídos del lado que mira.
  const markRead = useCallback(async () => {
    const cambio = viewerRole === 'buyer' ? { buyer_unread: 0 } : { vendor_unread: 0 };
    await supabase.from('store_conversations').update(cambio).eq('id', conversationId);
  }, [conversationId, viewerRole]);

  useEffect(() => {
    setLoading(true);
    load();
    markRead();
    // Refresco ligero para ver respuestas sin recargar (cada 8s mientras está abierto).
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load, markRead]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || !user) return;
    setSending(true);
    const { error } = await supabase.from('store_messages').insert({
      conversation_id: conversationId,
      sender_id: user.id,
      body,
    });
    setSending(false);
    if (error) {
      toast({ title: 'No se pudo enviar', description: error.message, variant: 'destructive' });
      return;
    }
    setText('');
    load();
  };

  return (
    <div className="flex flex-col h-96 max-h-sheet">
      <div className="flex-1 overflow-y-auto space-y-2 p-1">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center px-6">
            Aún no hay mensajes. Escribe el primero 👇
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.sender_id === user?.id;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                  mine ? 'bg-primary text-primary-foreground rounded-br-sm'
                       : 'bg-muted text-foreground rounded-bl-sm'}`}>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`text-[10px] mt-1 ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {new Date(m.created_at).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 pt-2 border-t mt-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Escribe un mensaje…"
          disabled={sending}
        />
        <Button size="icon" onClick={send} disabled={sending || !text.trim()} aria-label="Enviar">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
