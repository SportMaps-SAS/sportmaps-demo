import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  MapPin,
  Phone,
  Mail,
  Star,
  CheckCircle2,
  Globe,
  Users,
  Clock,
  Trophy,
  Heart,
  Share2,
  ArrowLeft,
  Calendar,
  Award,
  GraduationCap,
  Building,
  CalendarCheck
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { EnrollmentAuthModal } from '@/components/explore/EnrollmentAuthModal';
import { PlanCard, type PlanFeature, type PlanDuration } from '@/components/explore/PlanCard';
import { PaymentModal } from '@/components/payment/PaymentModal';
import { ChildSelectorModal } from '@/components/enrollment/ChildSelectorModal';
import { DirectionsButton } from '@/components/common/DirectionsButton';
import { FacilityReservationModal } from '@/components/school/FacilityReservationModal';
import { formatFriendlyDuration } from '@/lib/utils';

interface School {
  id: string;
  name: string;
  description: string | null;
  city: string;
  address: string;
  phone: string;
  email: string;
  website: string | null;
  sports: string[] | null;
  amenities: string[] | null;
  avg_rating: number | null;
  review_count: number | null;
  verified: boolean;
  logo_url: string | null;
  cover_image_url: string | null;
  owner_id: string;
  latitude?: number | null;
  longitude?: number | null;
  // New evolution fields
  certifications?: string[] | null;
  levels_offered?: string[] | null;
  accepts_reservations?: boolean;
}

interface Program {
  id: string;
  name: string;
  description: string | null;
  sport: string;
  schedule: any | null;
  price_monthly: number;
  age_min: number | null;
  age_max: number | null;
  max_students: number | null;
  current_students: number;
  active: boolean | null;
  // New evolution fields
  level?: string;
  spots_available?: number;
}

interface Facility {
  id: string;
  name: string;
  type: string;
  capacity: number;
  status: string;
  hourly_rate?: number;
  booking_enabled?: boolean;
  school_id?: string;
  /** Reservas F1: quién puede reservar. No llega si la base aún no tiene la columna. */
  bookable_by?: 'members' | 'public' | 'both' | null;
}

interface OfferingPlan {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  duration_days: number;
  max_sessions: number | null;
  is_active: boolean;
}

interface Offering {
  id: string;
  name: string;
  description: string | null;
  sport: string | null;
  offering_type: string;
  is_active: boolean;
  offering_plans: OfferingPlan[];
}

export default function SchoolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { toast } = useToast();

  const [school, setSchool] = useState<School | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [childSelectionOpen, setChildSelectionOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [selectedProgram, setSelectedProgram] = useState<Program | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [reservationModalOpen, setReservationModalOpen] = useState(false);
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);

  useEffect(() => {
    if (id) {
      fetchSchoolData();
    }
  }, [id]);

  const fetchSchoolData = async () => {
    if (!id || id === "") return;
    try {
      setLoading(true);

      // Fetch school details
      const { data: schoolData, error: schoolError } = await supabase
        .from('schools')
        .select('*')
        .eq('id', id)
        .single();

      if (schoolError) throw schoolError;
      setSchool(schoolData);

      // Fetch offerings + offering_plans (nueva arquitectura v2.1)
      // Estos son los planes que el owner edita desde Mi Perfil Publico → tab Planes.
      const { data: offeringsData } = await supabase
        .from('offerings')
        .select('id, name, description, sport, offering_type, is_active, offering_plans(id, name, description, price, currency, duration_days, max_sessions, is_active)')
        .eq('school_id', id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      const activeOfferings = (offeringsData as unknown as Offering[] | null)?.filter(
        o => (o.offering_plans ?? []).some(p => p.is_active)
      ) ?? [];
      setOfferings(activeOfferings);

      // Fallback: fetch programs from teams (legacy)
      if (activeOfferings.length === 0) {
        const { data: programsData, error: programsError } = await supabase
          .from('teams')
          .select('*')
          .eq('school_id', id)
          .eq('active', true)
          .order('name');

        if (programsError && programsError.code !== 'PGRST116') throw programsError;

        if (!programsData || programsData.length === 0) {
          setPrograms(getDemoPrograms(schoolData.name, schoolData.sports?.[0] || 'Fútbol'));
        } else {
          setPrograms(programsData);
        }
      } else {
        setPrograms([]);
      }

      // Fetch facilities for reservations
      const { data: facilitiesData } = await supabase
        .from('facilities')
        .select('*')
        .eq('school_id', id)
        .eq('status', 'available');

      // Sin instalaciones: estado vacío honesto (no se inventan instalaciones demo).
      // bookable_by es text + CHECK en la base: types.ts lo trae como string.
      setFacilities((facilitiesData ?? []) as Facility[]);
    } catch (error: any) {
      console.error('Error fetching school data:', error);
      toast({
        title: 'Error',
        description: 'No se pudo cargar la información de la escuela',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Solo instalaciones que reciben reservas; el precio es el real (sin tarifa = a convenir).
  const bookableFacilities = facilities.filter((f) => f.booking_enabled !== false);
  const rates = bookableFacilities.map((f) => Number(f.hourly_rate)).filter((r) => r > 0);
  const minHourlyRate = rates.length > 0 ? Math.min(...rates) : null;

  const handleEnroll = (program: Program) => {
    setSelectedProgram(program);

    if (!user) {
      // Usuario no autenticado - mostrar modal de auth con selección de rol
      setAuthModalOpen(true);
      return;
    }

    // Si es atleta, se inscribe directamente (sin selección de hijo)
    if (profile?.role === 'athlete') {
      setPaymentModalOpen(true);
      return;
    }

    // Padres u otros roles - seleccionar hijo primero
    setChildSelectionOpen(true);
  };

  // v2.1: guardamos offering + plan separados para que el PaymentModal pueda pasar
  // offering_plan_id real al backend (no un pseudo-id con ":").
  const [selectedOffering, setSelectedOffering] = useState<{ offering: Offering; planId: string; planLabel: string; price: number } | null>(null);

  const handleEnrollOffering = (offering: Offering, plan: { price: number; durationDays: number; key: string; label: string }) => {
    const pseudoProgram: Program = {
      id: plan.key,  // el id real del offering_plan
      name: `${offering.name} · ${plan.label}`,
      description: offering.description,
      sport: offering.sport ?? 'Multideporte',
      schedule: null,
      price_monthly: plan.price,
      age_min: null,
      age_max: null,
      max_students: null,
      current_students: 0,
      active: true,
    };
    setSelectedOffering({ offering, planId: plan.key, planLabel: plan.label, price: plan.price });
    handleEnroll(pseudoProgram);
  };

  const handleChildSelected = (childId: string, childName: string) => {
    setSelectedChildId(childId);
    setChildSelectionOpen(false);
    setPaymentModalOpen(true);
  };

  const handlePaymentSuccess = () => {
    toast({
      title: 'SportMaps: Tu inscripción se ha sincronizado con tu calendario',
      description: 'Revisa tu calendario para ver los detalles de tus clases',
    });
    fetchSchoolData();
    setPaymentModalOpen(false);
    setSelectedProgram(null);
    setSelectedChildId(null);
  };

  const getAgeRange = (program: Program) => {
    if (!program.age_min && !program.age_max) return 'Todas las edades';
    if (!program.age_max) return `${program.age_min}+ años`;
    if (!program.age_min) return `Hasta ${program.age_max} años`;
    return `${program.age_min}-${program.age_max} años`;
  };

  const getAvailability = (program: Program) => {
    if (!program.max_students) return 'Cupos ilimitados';
    const available = program.max_students - program.current_students;
    return available > 0 ? `${available} cupos disponibles` : 'Lleno';
  };

  const getDemoPrograms = (schoolName: string, sport: string): Program[] => {
    return [
      {
        id: 'demo-1',
        name: `${sport} Inicial`,
        description: 'Programa diseñado para principiantes. Aprende las técnicas básicas y fundamentos del deporte en un ambiente divertido y seguro.',
        sport: sport,
        schedule: 'Lunes y Miércoles 4:00 PM - 5:30 PM',
        price_monthly: 45000,
        age_min: 6,
        age_max: 10,
        max_students: 20,
        current_students: 12,
        active: true
      },
      {
        id: 'demo-2',
        name: `${sport} Intermedio`,
        description: 'Nivel intermedio para deportistas con experiencia previa. Desarrolla habilidades técnicas avanzadas y trabajo en equipo.',
        sport: sport,
        schedule: 'Martes y Jueves 5:00 PM - 6:30 PM',
        price_monthly: 55000,
        age_min: 11,
        age_max: 15,
        max_students: 18,
        current_students: 15,
        active: true
      },
      {
        id: 'demo-3',
        name: `${sport} Competitivo`,
        description: 'Programa de alto rendimiento para atletas que buscan competir a nivel profesional. Entrenamientos intensivos y preparación para torneos.',
        sport: sport,
        schedule: 'Lunes a Viernes 6:00 PM - 8:00 PM',
        price_monthly: 75000,
        age_min: 14,
        age_max: 18,
        max_students: 15,
        current_students: 14,
        active: true
      }
    ];
  };

  const getDemoReviews = () => {
    return [
      {
        id: 'review-1',
        author: 'María González',
        rating: 5,
        date: 'Hace 2 semanas',
        comment: 'Excelente academia! Los entrenadores son muy profesionales y dedicados. Mi hijo ha mejorado muchísimo desde que empezó.'
      },
      {
        id: 'review-2',
        author: 'Carlos Martínez',
        rating: 5,
        date: 'Hace 1 mes',
        comment: 'Las instalaciones son de primera calidad y el ambiente es muy amigable. Totalmente recomendado para niños y adolescentes.'
      },
      {
        id: 'review-3',
        author: 'Ana López',
        rating: 4,
        date: 'Hace 2 meses',
        comment: 'Muy buena experiencia en general. Los horarios son flexibles y el equipo es muy atento. Solo mejoraría la comunicación con los padres.'
      }
    ];
  };

  const handleReserveNow = () => {
    if (!user) {
      // Si hay programas, seleccionar el primero para mostrar el modal
      if (programs.length > 0) {
        setSelectedProgram(programs[0]);
        setAuthModalOpen(true);
      }
    } else {
      toast({
        title: 'Información',
        description: 'Por favor selecciona un programa para inscribirte',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!school) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Escuela no encontrada</h1>
        <Button onClick={() => navigate('/explore')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Volver a explorar
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Enrollment Auth Modal - For unauthenticated users */}
      <EnrollmentAuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        team={selectedProgram ? {
          id: selectedProgram.id,
          name: selectedProgram.name,
          price: selectedProgram.price_monthly
        } : undefined}
        school={school ? {
          id: school.id,
          name: school.name
        } : undefined}
      />

      {/* Child Selection Modal - NEW */}
      <ChildSelectorModal
        open={childSelectionOpen}
        onOpenChange={setChildSelectionOpen}
        onChildSelected={handleChildSelected}
        programName={selectedProgram?.name}
        schoolId={id}
      />

      {/* Payment Modal - For authenticated users */}
      {selectedProgram && (
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          item={{
            type: 'enrollment',
            id: selectedProgram.id,
            name: selectedProgram.name,
            description: school?.name,
            amount: selectedProgram.price_monthly,
            schoolId: school?.id,
            // v2.1: si viene de offering, pasamos offering_plan_id; si no, teamId legacy
            teamId: selectedOffering ? undefined : selectedProgram.id,
            offeringPlanId: selectedOffering?.planId,
            childId: selectedChildId || undefined,
          }}
          onSuccess={handlePaymentSuccess}
        />
      )}

      {/* Facility Reservation Modal */}
      <FacilityReservationModal
        open={reservationModalOpen}
        onOpenChange={setReservationModalOpen}
        facility={selectedFacility}
        schoolName={school?.name || ''}
        schoolPhone={school?.phone}
        schoolEmail={school?.email}
      />

      {/* Cover Image */}
      <div
        className="h-64 md:h-80 bg-gradient-to-br from-primary/20 to-secondary/20 bg-cover bg-center relative"
        style={
          school.cover_image_url
            ? { backgroundImage: `url(${school.cover_image_url})` }
            : undefined
        }
      >
        <div className="absolute inset-0 bg-black/40" />
        <div className="container mx-auto px-4 h-full flex items-end pb-8 relative">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/explore')}
            className="absolute top-4 left-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Volver
          </Button>
        </div>
      </div>

      <div className="container mx-auto px-4 -mt-16 relative z-10 pb-8">
        {/* Header Card */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-6">
              {/* Logo */}
              <Avatar className="h-24 w-24 border-4 border-background">
                <AvatarImage src={school.logo_url || undefined} />
                <AvatarFallback className="text-2xl">
                  {school.name.charAt(0)}
                </AvatarFallback>
              </Avatar>

              {/* Info */}
              <div className="flex-1">
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <h1 className="text-3xl font-bold">{school.name}</h1>
                      {school.verified && (
                        <Badge variant="default" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Verificada
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <MapPin className="h-4 w-4" />
                        <span>{school.city}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        <span className="font-semibold">{(school.avg_rating || 0).toFixed(1)}</span>
                        <span>({school.review_count || 0} reseñas)</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button variant="outline" size="icon">
                      <Share2 className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="icon">
                      <Heart className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {school.description && (
                  <p className="text-muted-foreground mb-4">{school.description}</p>
                )}

                {/* Certifications/Endorsements - NEW */}
                {school.certifications && school.certifications.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {school.certifications.map((cert) => (
                      <Badge key={cert} variant="outline" className="gap-1 border-primary/30 text-primary">
                        <Award className="h-3 w-3" />
                        {cert}
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Levels Offered - NEW */}
                {school.levels_offered && school.levels_offered.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {school.levels_offered.map((level) => (
                      <Badge key={level} variant="secondary" className="gap-1">
                        <GraduationCap className="h-3 w-3" />
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Sports */}
                {school.sports && school.sports.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {school.sports.map((sport) => (
                      <Badge key={sport} variant="secondary">
                        {sport}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Content */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Left Column - Details */}
          <div className="md:col-span-2 space-y-6">
            <Tabs defaultValue="programs" className="w-full">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="programs">Programas</TabsTrigger>
                <TabsTrigger value="reservations">Reservas</TabsTrigger>
                <TabsTrigger value="about">Info</TabsTrigger>
                <TabsTrigger value="reviews">Reseñas</TabsTrigger>
              </TabsList>

              {/* Programs Tab — Fitpal-style plan cards */}
              <TabsContent value="programs">
                {offerings.length === 0 && programs.length === 0 ? (
                  <Card className="p-12 text-center">
                    <Trophy className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-semibold mb-2">
                      No hay programas disponibles
                    </h3>
                    <p className="text-muted-foreground">
                      Esta escuela aún no ha publicado programas
                    </p>
                  </Card>
                ) : offerings.length > 0 ? (
                  // Nueva arquitectura: offerings con sus offering_plans como duraciones
                  <>
                    <div className="text-center mb-6">
                      <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Encuentra el plan ideal para ti</h2>
                      <p className="text-muted-foreground mt-1">Elige entre los servicios que ofrece {school.name}</p>
                    </div>
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                      {offerings.map((off) => {
                        const activePlans = (off.offering_plans ?? []).filter(p => p.is_active);
                        if (activePlans.length === 0) return null;

                        const features: PlanFeature[] = [];
                        if (off.description) {
                          off.description.split(/\.\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3)
                            .slice(0, 4).forEach(s => features.push({ label: s.replace(/\.$/, '') }));
                        }
                        const firstPlan = activePlans[0];
                        if (firstPlan?.max_sessions != null) {
                          features.push({ label: `${firstPlan.max_sessions} sesiones incluidas` });
                        }
                        if (features.length === 0) {
                          const typeLabel: Record<string, string> = {
                            session_pack: 'Paquete de clases',
                            monthly: 'Mensualidad',
                            drop_in: 'Clase suelta',
                            subscription: 'Suscripción',
                            class: 'Clases regulares',
                            program: 'Programa deportivo',
                          };
                          features.push({ label: typeLabel[off.offering_type] ?? 'Programa deportivo' });
                        }

                        const durations: PlanDuration[] = activePlans.map(p => {
                          const priceFmt = `$${p.price.toLocaleString('es-CO')}`;
                          const label = `${formatFriendlyDuration(p.duration_days)} / ${priceFmt}`;
                          return {
                            key: p.id,
                            label: p.name ? `${p.name} - ${label}` : label,
                            price: p.price,
                            durationDays: p.duration_days,
                          };
                        });

                        return (
                          <PlanCard
                            key={off.id}
                            title={off.name}
                            sport={off.sport ?? undefined}
                            features={features}
                            durations={durations}
                            primaryCta="Inscribirme"
                            onPrimary={(selected) => handleEnrollOffering(off, selected)}
                          />
                        );
                      })}
                    </div>
                  </>
                ) : (
                  // Fallback legacy: tabla teams
                  <>
                    <div className="text-center mb-6">
                      <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Encuentra el plan ideal para ti</h2>
                      <p className="text-muted-foreground mt-1">Elige entre los programas que ofrece {school.name}</p>
                    </div>
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                      {programs.map((program) => {
                        const isFull = program.max_students !== null && program.current_students >= program.max_students;
                        const features: PlanFeature[] = [];

                        if (program.description) {
                          program.description
                            .split(/\.\s+|\n+/)
                            .map(s => s.trim())
                            .filter(s => s.length > 3)
                            .slice(0, 4)
                            .forEach(s => features.push({ label: s.replace(/\.$/, '') }));
                        }
                        features.push({ label: `Edades: ${getAgeRange(program)}` });
                        if (program.schedule) {
                          const sched = typeof program.schedule === 'string' ? program.schedule : JSON.stringify(program.schedule);
                          features.push({ label: `Horario: ${sched}` });
                        }
                        features.push({ label: getAvailability(program) });

                        const badges: { label: string; tone?: 'destructive' | 'secondary' | 'outline' }[] = [];
                        if (program.spots_available !== undefined && program.spots_available <= 5 && program.spots_available > 0) {
                          badges.push({ label: `¡Solo ${program.spots_available} cupos!`, tone: 'destructive' });
                        }

                        const durations: PlanDuration[] = [{
                          key: 'monthly',
                          label: `1 mes - 30 días / $${program.price_monthly.toLocaleString('es-CO')}`,
                          price: program.price_monthly,
                          durationDays: 30,
                        }];

                        return (
                          <PlanCard
                            key={program.id}
                            title={program.name}
                            sport={program.sport}
                            level={program.level ? program.level.charAt(0).toUpperCase() + program.level.slice(1) : null}
                            badges={badges}
                            features={features}
                            durations={durations}
                            primaryCta="Inscribirme"
                            onPrimary={() => handleEnroll(program)}
                            disabled={isFull}
                            disabledLabel="Programa lleno"
                          />
                        );
                      })}
                    </div>
                  </>
                )}
              </TabsContent>

              {/* Reservations Tab - NEW */}
              <TabsContent value="reservations" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CalendarCheck className="h-5 w-5 text-primary" />
                      Prácticas Libres y Reservas
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-4">
                      Reserva canchas y espacios para prácticas libres.
                      {minHourlyRate !== null && ` Desde $${minHourlyRate.toLocaleString('es-CO')}/hora.`}
                    </p>

                    {bookableFacilities.length === 0 ? (
                      <div className="text-center py-8">
                        <Building className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                        <p className="text-muted-foreground">Esta escuela aún no tiene instalaciones disponibles para reservar</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {bookableFacilities.map((facility) => (
                          <div
                            key={facility.id}
                            className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                <Building className="h-5 w-5 text-primary" />
                              </div>
                              <div>
                                <p className="font-semibold">{facility.name}</p>
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <Users className="h-3 w-3" />
                                  <span>Capacidad: {facility.capacity}</span>
                                  <span>•</span>
                                  <span>{facility.type}</span>
                                  {facility.bookable_by === 'members' && (
                                    <>
                                      <span>•</span>
                                      <span className="font-medium">Solo miembros</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                {facility.hourly_rate && facility.hourly_rate > 0 ? (
                                  <>
                                    <p className="font-bold text-primary">
                                      ${facility.hourly_rate.toLocaleString('es-CO')}
                                    </p>
                                    <p className="text-xs text-muted-foreground">por hora</p>
                                  </>
                                ) : (
                                  <p className="text-xs font-medium text-muted-foreground max-w-[9rem]">
                                    Precio a convenir con la escuela
                                  </p>
                                )}
                              </div>
                              <Button
                                size="sm"
                                className="bg-[#FB9F1E] hover:bg-[#e08a1a] text-white"
                                onClick={() => {
                                  if (!user) {
                                    setAuthModalOpen(true);
                                  } else {
                                    setSelectedFacility(facility);
                                    setReservationModalOpen(true);
                                  }
                                }}
                              >
                                <CalendarCheck className="h-4 w-4 mr-1" />
                                Reservar
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* About Tab */}
              <TabsContent value="about">
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <div>
                      <h3 className="font-semibold mb-3">Acerca de nosotros</h3>
                      <p className="text-muted-foreground leading-relaxed">
                        {school.description || `En ${school.name}, nos dedicamos a formar atletas integrales a través de programas deportivos de alta calidad. Contamos con entrenadores certificados y experiencia comprobada en el desarrollo de jóvenes talentos. Nuestras instalaciones modernas y metodología de entrenamiento garantizan el mejor ambiente para el crecimiento deportivo y personal de nuestros deportistas.`}
                      </p>
                    </div>

                    <Separator />

                    {school.amenities && school.amenities.length > 0 && (
                      <>
                        <div>
                          <h3 className="font-semibold mb-3">Instalaciones</h3>
                          <div className="grid grid-cols-2 gap-2">
                            {school.amenities.map((amenity) => (
                              <div key={amenity} className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary" />
                                <span className="text-sm">{amenity}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <Separator />
                      </>
                    )}

                    <div>
                      <h3 className="font-semibold mb-3">Ubicación</h3>
                      <p className="text-muted-foreground">{school.address}</p>
                    </div>

                    <Separator />

                    <div>
                      <h3 className="font-semibold mb-3">Horarios de atención</h3>
                      <p className="text-muted-foreground">Lunes a Viernes: 8:00 AM - 8:00 PM</p>
                      <p className="text-muted-foreground">Sábados: 9:00 AM - 2:00 PM</p>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Reviews Tab */}
              <TabsContent value="reviews" className="space-y-4">
                {getDemoReviews().map((review) => (
                  <Card key={review.id}>
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold">{review.author}</p>
                          <p className="text-sm text-muted-foreground">{review.date}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          {Array.from({ length: review.rating }).map((_, i) => (
                            <Star key={i} className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                          ))}
                        </div>
                      </div>
                      <p className="text-muted-foreground">{review.comment}</p>
                    </CardContent>
                  </Card>
                ))}

                <Card className="bg-muted/50">
                  <CardContent className="p-6 text-center">
                    <p className="text-muted-foreground">
                      ¿Ya conoces esta academia? Inicia sesión para dejar tu reseña
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* Right Column - Contact Info */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Información de Contacto</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-3">
                  <MapPin className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Dirección</p>
                    <p className="text-sm text-muted-foreground">{school.address}</p>
                  </div>
                </div>

                <Separator />

                <div className="flex items-start gap-3">
                  <Phone className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Teléfono</p>
                    <a
                      href={`tel:${school.phone}`}
                      className="text-sm text-primary hover:underline"
                    >
                      {school.phone}
                    </a>
                  </div>
                </div>

                <Separator />

                <div className="flex items-start gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Email</p>
                    <a
                      href={`mailto:${school.email}`}
                      className="text-sm text-primary hover:underline break-all"
                    >
                      {school.email}
                    </a>
                  </div>
                </div>

                {school.website && (
                  <>
                    <Separator />
                    <div className="flex items-start gap-3">
                      <Globe className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">Sitio Web</p>
                        <a
                          href={school.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline break-all"
                        >
                          {school.website}
                        </a>
                      </div>
                    </div>
                  </>
                )}

                <Separator />

                {/* Directions Button */}
                <DirectionsButton
                  latitude={4.6097} // Default Bogotá coordinates - would use school.latitude if available
                  longitude={-74.0817}
                  placeName={school.name}
                  address={`${school.address}, ${school.city}`}
                  className="w-full"
                  size="lg"
                />

                <Button
                  className="w-full"
                  onClick={handleReserveNow}
                  size="lg"
                  variant="outline"
                >
                  <Calendar className="h-5 w-5 mr-2" />
                  Reservar Ahora
                </Button>

                <p className="text-xs text-center text-muted-foreground mt-2">
                  Selecciona un programa y completa tu reserva
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
