import { useState, useCallback } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import type { Event, EventRegistration, EventFormData, EventFilters, TelemetryEventType, EventStats } from '@/types/events';

export function useEvents() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  // Generate slug from title
  const generateSlug = (title: string): string => {
    const slug = title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    // Add random suffix for uniqueness
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${slug}-${suffix}`;
  };

  // Create event
  const createEvent = useCallback(async (data: EventFormData): Promise<Event | null> => {
    if (!user) {
      toast({ title: 'Error', description: 'Debes iniciar sesión', variant: 'destructive' });
      return null;
    }

    setLoading(true);
    try {
      const slug = generateSlug(data.title);
      const creatorRole = profile?.role === 'school' ? 'school' : 'organizer';

      const { data: event, error } = await supabase
        .from('events')
        .insert({
          ...data,
          slug,
          creator_id: user.id,
          creator_role: creatorRole,
          status: 'active',
          currency: 'COP'
        })
        .select()
        .single();

      if (error) throw error;

      // Log telemetry
      await logTelemetry('event_created', event.id);

      toast({ title: '¡Evento creado!', description: 'Tu evento está listo para recibir inscripciones' });
      return event as Event;
    } catch (error: any) {
      console.error('Error creating event:', error);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return null;
    } finally {
      setLoading(false);
    }
  }, [user, profile, toast]);

  // Get my events
  const getMyEvents = useCallback(async (): Promise<Event[]> => {
    if (!user) return [];

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('events')
        .select('id, title, slug, event_date, start_time, city, status, price, registrations_open')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as Event[];
    } catch (error: any) {
      console.error('Error fetching events:', error);
      return [];
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Get public events (for map view)
  const getPublicEvents = useCallback(async (filters?: EventFilters): Promise<Event[]> => {
    setLoading(true);
    try {
      let query = supabase
        .from('events')
        .select('id, title, slug, event_date, start_time, city, sport, capacity, image_url, price, status, registrations_open, event_type')
        .eq('status', 'active')
        .eq('visibility', 'public')
        .eq('registrations_open', true)
        .gte('event_date', todayColombia());

      if (filters?.sport) query = query.eq('sport', filters.sport);
      if (filters?.city) query = query.eq('city', filters.city);
      if (filters?.event_type) query = query.eq('event_type', filters.event_type);

      const { data, error } = await query.order('event_date', { ascending: true });

      if (error) throw error;
      return data as Event[];
    } catch (error: any) {
      console.error('Error fetching public events:', error);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // Get event by slug (public)
  const getEventBySlug = useCallback(async (slug: string): Promise<Event | null> => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('events')
        .select(`
          *,
          categories:event_categories_config(*),
          phases:event_price_phases(*)
        `)
        .eq('slug', slug)
        .single();

      if (error) throw error;

      // Log view
      if (data) await logTelemetry('event_viewed', data.id);

      return data as any;
    } catch (error: any) {
      console.error('Error fetching event:', error);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Get event by ID with registrations count
  const getEventWithStats = useCallback(async (eventId: string): Promise<Event | null> => {
    try {
      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('*')
        .eq('id', eventId)
        .single();

      if (eventError) throw eventError;

      // Get registration counts
      const { data: registrations } = await supabase
        .from('event_registrations')
        .select('status')
        .eq('event_id', eventId);

      const approved = registrations?.filter(r => r.status === 'approved').length || 0;
      const pending = registrations?.filter(r => r.status === 'pending').length || 0;

      return {
        ...event,
        approved_count: approved,
        pending_count: pending,
        available_spots: Math.max(0, (event.capacity || 0) - approved)
      } as Event;
    } catch (error: any) {
      console.error('Error fetching event:', error);
      return null;
    }
  }, []);

  // Update event
  const updateEvent = useCallback(async (eventId: string, updates: Partial<Event>): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('events')
        // Event (tipo de la app) es más ancho que la tabla; se manda tal cual,
        // igual que antes de supabase-js 2.118 (que rechaza propiedades extra).
        .update(updates as TablesUpdate<'events'>)
        .eq('id', eventId)
        .eq('creator_id', user?.id);

      if (error) throw error;

      toast({ title: 'Evento actualizado', description: 'Los cambios han sido guardados' });
      return true;
    } catch (error: any) {
      console.error('Error updating event:', error);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return false;
    }
  }, [user, toast]);

  // Close registrations
  const closeRegistrations = useCallback(async (eventId: string): Promise<boolean> => {
    return updateEvent(eventId, { registrations_open: false, status: 'closed' });
  }, [updateEvent]);

  // Log telemetry
  // `metadata` termina en una columna jsonb: se declara como algo serializable
  // y no como `object`, que no es asignable a Json.
  const logTelemetry = useCallback(async (eventType: TelemetryEventType, eventId?: string, metadata?: Record<string, unknown>) => {
    try {
      await supabase.from('event_telemetry').insert({
        event_id: eventId,
        user_id: user?.id,
        event_type: eventType,
        metadata: (metadata ?? {}) as never   // jsonb: la forma exacta la decide quien llama
      });
    } catch (error) {
      console.error('Telemetry error:', error);
    }
  }, [user]);

  // Get stats for organizer dashboard
  const getOrganizerStats = useCallback(async (): Promise<EventStats> => {
    if (!user) return { total_events: 0, active_events: 0, total_registrations: 0, pending_registrations: 0, approved_registrations: 0 };

    try {
      // Get events count
      const { data: events } = await supabase
        .from('events')
        .select('id, status')
        .eq('creator_id', user.id);

      const eventIds = events?.map(e => e.id) || [];
      const activeEvents = events?.filter(e => e.status === 'active').length || 0;

      if (eventIds.length === 0) {
        return { total_events: 0, active_events: 0, total_registrations: 0, pending_registrations: 0, approved_registrations: 0 };
      }

      // Get registrations count
      const { data: registrations } = await supabase
        .from('event_registrations')
        .select('status')
        .in('event_id', eventIds);

      return {
        total_events: events?.length || 0,
        active_events: activeEvents,
        total_registrations: registrations?.length || 0,
        pending_registrations: registrations?.filter(r => r.status === 'pending').length || 0,
        approved_registrations: registrations?.filter(r => r.status === 'approved').length || 0
      };
    } catch (error) {
      console.error('Error fetching stats:', error);
      return { total_events: 0, active_events: 0, total_registrations: 0, pending_registrations: 0, approved_registrations: 0 };
    }
  }, [user]);

  return {
    loading,
    createEvent,
    getMyEvents,
    getPublicEvents,
    getEventBySlug,
    getEventWithStats,
    updateEvent,
    closeRegistrations,
    logTelemetry,
    getOrganizerStats
  };
}

// Separate hook for registrations
export function useEventRegistrations(eventId?: string) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  // Get registrations for an event
  const getRegistrations = useCallback(async (): Promise<EventRegistration[]> => {
    if (!eventId) return [];

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('event_registrations')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as EventRegistration[];
    } catch (error: any) {
      console.error('Error fetching registrations:', error);
      return [];
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  // Create registration (public - no auth required)
  const createRegistration = useCallback(async (
    eventId: string,
    data: {
      participant_name: string;
      participant_email?: string;
      participant_phone: string;
      participant_role?: string;
      participant_age?: number;
      notes?: string;
      payment_proof_url?: string;
    }
  ): Promise<boolean> => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from('event_registrations')
        .insert({
          event_id: eventId,
          ...data,
          status: 'pending',
          payment_status: data.payment_proof_url ? 'pending' : 'not_required',
          user_id: user?.id
        });

      if (error) throw error;

      // Log telemetry
      await supabase.from('event_telemetry').insert({
        event_id: eventId,
        user_id: user?.id,
        event_type: 'registration_created',
        metadata: { participant_role: data.participant_role }
      });

      toast({ title: '¡Inscripción enviada!', description: 'El organizador te contactará pronto' });
      return true;
    } catch (error: any) {
      console.error('Error creating registration:', error);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return false;
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  // Approve registration
  const approveRegistration = useCallback(async (registrationId: string): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('event_registrations')
        .update({ status: 'approved', payment_status: 'verified' })
        .eq('id', registrationId);

      if (error) throw error;

      // Log telemetry
      await supabase.from('event_telemetry').insert({
        event_id: eventId,
        user_id: user?.id,
        event_type: 'registration_approved'
      });

      toast({ title: 'Inscripción aprobada' });
      return true;
    } catch (error: any) {
      console.error('Error approving registration:', error);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return false;
    }
  }, [eventId, user, toast]);

  // Reject registration
  const rejectRegistration = useCallback(async (registrationId: string, reason?: string): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('event_registrations')
        .update({ status: 'rejected', rejection_reason: reason })
        .eq('id', registrationId);

      if (error) throw error;

      toast({ title: 'Inscripción rechazada' });
      return true;
    } catch (error: any) {
      console.error('Error rejecting registration:', error);
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return false;
    }
  }, [toast]);

  return {
    loading,
    getRegistrations,
    createRegistration,
    approveRegistration,
    rejectRegistration
  };
}
