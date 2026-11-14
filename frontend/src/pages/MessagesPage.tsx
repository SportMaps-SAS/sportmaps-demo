import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { esAcudienteV2 } from '@/lib/vistaAcudiente';
import { whatsappDeLaEscuela } from '@/lib/whatsappEscuela';
import { MensajesV2 } from '@/components/messages/MensajesV2';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  MessageSquare,
  Search,
  Inbox,
  MessagesSquare,
} from 'lucide-react';

interface Conversation {
  id: string;
  sender_id: string;
  recipient_id: string;
  subject: string;
  content: string;
  read: boolean;
  created_at: string;
  // Joined profile data
  other_user_name: string;
  other_user_avatar: string | null;
}

export default function MessagesPage() {
  const { user, profile } = useAuth();
  const { currentUserRole, schoolId, schoolName } = useSchoolContext();
  const acudienteV2 = esAcudienteV2(currentUserRole ?? profile?.role);
  const esEscuela = ['school', 'school_admin'].includes(currentUserRole ?? profile?.role ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  // Fetch real messages from Supabase
  const { data: messages, isLoading, isError, refetch } = useQuery({
    queryKey: ['messages', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      // Fetch messages where user is sender or recipient
      const { data: sentMessages, error: sentError } = await supabase
        .from('messages')
        .select(`
          id, sender_id, recipient_id, subject, content, read, created_at
        `)
        .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order('created_at', { ascending: false });

      // Antes devolvía [] y un error se veía igual que «sin mensajes». Lanzar
      // no cambia la vista de siempre (sigue saliendo el estado vacío), pero
      // la V2 del acudiente sí puede mostrar el error con «Reintentar».
      if (sentError) {
        console.error('Error fetching messages:', sentError);
        throw sentError;
      }

      if (!sentMessages || sentMessages.length === 0) return [];

      // Get unique user IDs to fetch profiles
      const otherUserIds = [...new Set(
        sentMessages.map(m => m.sender_id === user.id ? m.recipient_id : m.sender_id)
      )];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', otherUserIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.id, { name: p.full_name || 'Usuario', avatar: p.avatar_url }])
      );

      return sentMessages.map(m => {
        const otherId = m.sender_id === user.id ? m.recipient_id : m.sender_id;
        const otherProfile = profileMap.get(otherId);
        return {
          ...m,
          other_user_name: otherProfile?.name || 'Usuario',
          other_user_avatar: otherProfile?.avatar || null,
        } as Conversation;
      });
    },
    enabled: !!user?.id,
  });

  const filteredMessages = (messages || []).filter(m =>
    m.other_user_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.subject.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group messages by other user (latest message per user)
  const conversations = filteredMessages.reduce<Conversation[]>((acc, msg) => {
    const otherId = msg.sender_id === user?.id ? msg.recipient_id : msg.sender_id;
    if (!acc.find(c => (c.sender_id === user?.id ? c.recipient_id : c.sender_id) === otherId)) {
      acc.push(msg);
    }
    return acc;
  }, []);

  const hasMessages = conversations.length > 0;

  // Celular del club para el acudiente (misma consulta y caché que «Más»).
  const { data: schoolPhone } = useQuery({
    queryKey: ['parent-more-school-phone', schoolId],
    enabled: acudienteV2 && !!schoolId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from('schools').select('phone').eq('id', schoolId!).maybeSingle();
      return (data?.phone as string | null) ?? null;
    },
  });

  if (acudienteV2) {
    return (
      <MensajesV2
        userId={user?.id}
        messages={messages ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => { void refetch(); }}
        whatsapp={whatsappDeLaEscuela(schoolPhone)}
        schoolName={schoolName}
      />
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <MessageSquare className="h-8 w-8 text-primary" />
          Mensajes
        </h1>
        <p className="text-muted-foreground mt-1">
          Comunícate con tu equipo y entrenadores
        </p>
      </div>

      {/* Acceso al WhatsApp de la escuela. /whatsapp ya resuelve los dos casos:
          con el canal conectado abre las conversaciones; sin conectar muestra
          el alta para activarlo. Sin consultas extra desde aquí. */}
      {esEscuela && (
        <Card>
          <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <MessageSquare className="h-5 w-5 text-primary shrink-0" />
              <p className="text-sm text-muted-foreground">
                Las familias te escriben por WhatsApp. Ábrelo o actívalo desde aquí.
              </p>
            </div>
            <Button asChild className="shrink-0">
              <Link to="/whatsapp?tab=conversaciones">WhatsApp</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && !hasMessages && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
              <Inbox className="w-10 h-10 text-primary/60" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Sin mensajes aún</h3>
            <p className="text-muted-foreground max-w-md mb-6 leading-relaxed">
              Cuando inicies conversaciones con entrenadores, coordinadores u otros miembros de tu escuela deportiva, tus mensajes aparecerán aquí.
            </p>
            <div className="flex items-center gap-3 text-sm text-muted-foreground bg-muted/50 rounded-lg px-5 py-3">
              <MessagesSquare className="w-5 h-5 text-primary/50 flex-shrink-0" />
              <span>Las interacciones con la plataforma generarán notificaciones y mensajes automáticamente.</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">Cargando mensajes...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Messages Layout - Only shown when there are messages */}
      {!isLoading && hasMessages && (
        <div className="grid md:grid-cols-3 gap-4 h-[calc(100dvh-15rem)]">
          {/* Contacts List */}
          <Card className="md:col-span-1">
            <CardHeader className="pb-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar conversaciones..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100dvh-21.25rem)]">
                <div className="space-y-1 p-2">
                  {conversations.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => setSelectedConversation(conv)}
                      className={`w-full p-3 rounded-lg text-left transition-colors hover:bg-accent ${selectedConversation?.id === conv.id ? 'bg-accent' : ''
                        }`}
                    >
                      <div className="flex items-start gap-3">
                        <Avatar>
                          <AvatarImage src={conv.other_user_avatar || undefined} />
                          <AvatarFallback>
                            {conv.other_user_name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <p className="font-medium text-sm truncate">
                              {conv.other_user_name}
                            </p>
                            <span className="text-xs text-muted-foreground">
                              {new Date(conv.created_at).toLocaleDateString('es-CO', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <p className="text-sm text-muted-foreground truncate">
                              {conv.content}
                            </p>
                            {!conv.read && conv.recipient_id === user?.id && (
                              <Badge variant="default" className="ml-2 h-5 min-w-5 flex items-center justify-center rounded-full p-1 text-xs">
                                •
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Chat Area */}
          <Card className="md:col-span-2 flex flex-col">
            {selectedConversation ? (
              <>
                <CardHeader className="border-b">
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage src={selectedConversation.other_user_avatar || undefined} />
                      <AvatarFallback>
                        {selectedConversation.other_user_name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{selectedConversation.other_user_name}</p>
                      <p className="text-xs text-muted-foreground">{selectedConversation.subject}</p>
                    </div>
                  </div>
                </CardHeader>
                <ScrollArea className="flex-1 p-4">
                  <div className="space-y-4">
                    {(messages || [])
                      .filter(m => {
                        const otherId = selectedConversation.sender_id === user?.id
                          ? selectedConversation.recipient_id
                          : selectedConversation.sender_id;
                        return m.sender_id === otherId || m.recipient_id === otherId;
                      })
                      .reverse()
                      .map((message) => (
                        <div
                          key={message.id}
                          className={`flex ${message.sender_id === user?.id ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[70%] rounded-lg p-3 ${message.sender_id === user?.id
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted'
                              }`}
                          >
                            <p className="text-sm">{message.content}</p>
                            <p className={`text-xs mt-1 ${message.sender_id === user?.id ? 'text-primary-foreground/70' : 'text-muted-foreground'
                              }`}>
                              {new Date(message.created_at).toLocaleTimeString('es-CO', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                          </div>
                        </div>
                      ))}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <CardContent className="flex-1 flex flex-col items-center justify-center text-center py-16">
                <MessageSquare className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground">Selecciona una conversación para ver los mensajes</p>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
