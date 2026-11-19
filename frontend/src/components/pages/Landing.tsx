import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
// import { WelcomeModal } from "@/components/modals/WelcomeModal";
import {
  MapPin,
  Zap,
  Users,
  TrendingUp,
  Trophy,
  Heart,
  ShoppingBag,
  Dumbbell,
  School,
  Target,
  Calendar,
  Star,
  Activity,
  Baby,
  GraduationCap,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Search,
  Facebook,
  Instagram,
  Twitter,
  Youtube,
  HelpCircle,
  Phone,
  ChevronRight,
  ChevronLeft
} from "lucide-react";
import heroImage from "@/assets/hero-sportsmaps.jpg";
import logoImage from "@/assets/logo-bienvenida.png";
import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { SALES_PHONE_TEL, SALES_PHONE_DISPLAY } from "@/lib/salesContact";

interface LandingProps {
  onNavigate?: (page: string) => void;
}

const Landing = ({ onNavigate }: LandingProps) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [showWelcomeModal, setShowWelcomeModal] = useState(false);

  /* 
  // Check if modal should be shown on mount
  useEffect(() => {
    // Don't show if user is logged in
    if (user) return;
    
    // Don't show if already dismissed in this session
    const dismissed = sessionStorage.getItem('sportmaps_welcome_dismissed');
    if (dismissed === 'true') return;

    // Show modal with a small delay for better UX
    const timer = setTimeout(() => {
      setShowWelcomeModal(true);
    }, 500);

    return () => clearTimeout(timer);
  }, [user]);
  */

  const heroSlides = [
    {
      title: "Nada desde $15.000",
      subtitle: "Reserva ahora tu práctica libre",
      cta: "Reservar Ahora",
      image: heroImage,
      action: () => navigate("/explore"),
      gradient: "from-primary/90 to-primary/70"
    },
    {
      title: "Fútbol como los grandes",
      subtitle: "Escuelas deportivas para todas las edades",
      cta: "Ver Escuelas",
      image: heroImage,
      action: () => navigate("/explore"),
      gradient: "from-primary/90 via-primary/80 to-orange/70"
    },
    {
      title: "Equipamiento profesional",
      subtitle: "Las mejores marcas al mejor precio",
      cta: "Ir a Tienda",
      image: heroImage,
      action: () => navigate("/shop"),
      gradient: "from-orange/90 to-orange-dark/70"
    }
  ];

  const quickLinks = [
    { icon: School, label: "Escuelas Deportivas", action: () => navigate("/explore") },
    { icon: Dumbbell, label: "Prácticas Libres", action: () => navigate("/explore") },
    { icon: Heart, label: "Planes de Gimnasio", action: () => navigate("/wellness") },
    { icon: ShoppingBag, label: "Tienda", action: () => navigate("/shop") }
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % heroSlides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const nextSlide = () => setCurrentSlide((prev) => (prev + 1) % heroSlides.length);
  const prevSlide = () => setCurrentSlide((prev) => (prev - 1 + heroSlides.length) % heroSlides.length);

  const services = [
    {
      icon: School,
      title: "Escuelas Deportivas",
      description: "Programas para todas las edades desde bebés hasta adultos mayores",
      features: ["Fútbol", "Natación", "Tenis", "Baloncesto", "Artes Marciales", "+20 disciplinas"],
      color: "primary",
      action: () => navigate("/explore")
    },
    {
      icon: ShoppingBag,
      title: "Tienda Deportiva",
      description: "Equipamiento profesional de marcas reconocidas",
      features: ["Calzado", "Ropa", "Tecnología", "Suplementos", "Accesorios"],
      color: "secondary",
      action: () => navigate("/shop")
    },
    {
      icon: Heart,
      title: "Bienestar y Salud",
      description: "Servicios especializados para tu recuperación y rendimiento",
      features: ["Fisioterapia", "Nutrición", "Psicología", "Recuperación", "Masajes"],
      color: "accent",
      action: () => navigate("/wellness")
    }
  ];

  const programs = [
    {
      icon: GraduationCap,
      title: "Escuelas Deportivas",
      description: "Formación integral para todas las edades con entrenadores certificados",
      age: "Desde 6 meses"
    },
    {
      icon: Dumbbell,
      title: "Prácticas Libres",
      description: "Acceso a instalaciones deportivas de primer nivel",
      age: "Todas las edades"
    },
    {
      icon: Trophy,
      title: "Alto Rendimiento",
      description: "Programas competitivos para atletas avanzados",
      age: "Juvenil y Adultos"
    },
    {
      icon: Target,
      title: "Torneos",
      description: "Competencias intercolegiales y empresariales",
      age: "Todas las categorías"
    }
  ];

  const ageGroups = [
    { icon: Baby, label: "Bebés", range: "6m - 3 años", programs: "Matronatación, Motricidad" },
    { icon: Users, label: "Niños", range: "4 - 12 años", programs: "14 escuelas deportivas" },
    { icon: GraduationCap, label: "Jóvenes", range: "13 - 17 años", programs: "Alto rendimiento" },
    { icon: Activity, label: "Adultos", range: "18 - 59 años", programs: "Gimnasio, Clases grupales" },
    { icon: Heart, label: "Adultos Mayores", range: "60+ años", programs: "Actividad física adaptada" },
    { icon: Sparkles, label: "Embarazadas", range: "Prenatal", programs: "Yoga, Natación" }
  ];

  const stats = [
    { number: "150+", label: "Escuelas Certificadas" },
    { number: "5,000+", label: "Atletas Activos" },
    { number: "25+", label: "Disciplinas Deportivas" },
    { number: "4.8", label: "Rating Promedio" }
  ];

  const benefits = [
    "Instalaciones de última generación",
    "Entrenadores certificados",
    "Programas para todas las edades",
    "Atención personalizada",
    "Asesoría nutricional incluida",
    "Seguimiento de rendimiento"
  ];

  return (
    <>
      {/* Welcome Modal */}
      {/* <WelcomeModal 
        open={showWelcomeModal} 
        onOpenChange={setShowWelcomeModal} 
      /> */}

      <div className="bg-background">
        <div className="bg-primary/10 border-b">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between h-10 text-sm">
              <div className="flex items-center gap-6">
                <a
                  href={SALES_PHONE_TEL}
                  className="flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors"
                >
                  <Phone className="h-4 w-4" />
                  <span className="hidden md:inline">{SALES_PHONE_DISPLAY}</span>
                </a>
              </div>
              <div className="flex items-center gap-3">
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Facebook className="h-4 w-4" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Instagram className="h-4 w-4" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Twitter className="h-4 w-4" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Youtube className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Main Header */}
        <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b shadow-sm sticky-safe">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between h-20">
              {/* Logo */}
              <Link to="/" className="flex items-center gap-2 cursor-pointer">
                <img
                  src={logoImage}
                  alt="SportMaps"
                  className="w-12 h-12 rounded-xl"
                />
                <div className="hidden md:block">
                  <div className="font-bold text-xl text-foreground">SportMaps</div>
                  <div className="text-xs brand-slogan">Revolucionando el sistema deportivo</div>
                </div>
              </Link>

              {/* Search Bar */}
              <div className="flex-1 max-w-xl mx-8 hidden lg:block">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    placeholder="Busca escuelas, tiendas o servicios..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-11 bg-muted/30 border-muted"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3">
                <ThemeToggle />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/shop")}
                  className="hidden md:flex"
                >
                  <ShoppingBag className="h-4 w-4 mr-2" />
                  Tienda
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                >
                  <Link to="/login">Ingresar</Link>
                </Button>
                <Button
                  variant="orange"
                  size="sm"
                  asChild
                >
                  <Link to="/register">Registrarse</Link>
                </Button>
              </div>
            </div>
          </div>
        </header>

        {/* Quick Links Bar */}
        <div className="bg-background border-b">
          <div className="container mx-auto px-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 py-4">
              {quickLinks.map((link, index) => {
                const Icon = link.icon;
                return (
                  <button
                    key={index}
                    onClick={link.action}
                    className="flex flex-col items-center gap-2 p-4 rounded-lg hover:bg-primary/5 transition-all group"
                  >
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 group-hover:scale-110 transition-all">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>
                    <span className="text-sm font-medium text-center">{link.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Hero Carousel */}
        <section className="relative h-[70vh] overflow-hidden">
          {/* Slides */}
          {heroSlides.map((slide, index) => (
            <div
              key={index}
              className={`absolute inset-0 transition-opacity duration-700 ${currentSlide === index ? 'opacity-100' : 'opacity-0'
                }`}
            >
              <img
                src={slide.image}
                alt={slide.title}
                className="w-full h-full object-cover"
              />
              <div className={`absolute inset-0 bg-gradient-to-r ${slide.gradient}`} />
            </div>
          ))}

          {/* Content */}
          <div className="container relative z-10 h-full flex items-center px-4">
            <div className="max-w-2xl text-white">
              <div className="animate-fade-in">
                <h1 className="text-5xl md:text-7xl font-bold mb-4">
                  {heroSlides[currentSlide].title}
                </h1>
                <p className="text-xl md:text-2xl mb-8 text-white/90">
                  {heroSlides[currentSlide].subtitle}
                </p>
                <Button
                  variant="elevation"
                  size="xl"
                  className="bg-white text-black hover:bg-white/90 shadow-2xl"
                  onClick={heroSlides[currentSlide].action}
                >
                  {heroSlides[currentSlide].cta}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </div>
            </div>
          </div>

          {/* Navigation Arrows */}
          <button
            aria-label="Diapositiva anterior"
            onClick={prevSlide}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-white/20 transition-all"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            aria-label="Diapositiva siguiente"
            onClick={nextSlide}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-white/20 transition-all"
          >
            <ChevronRight className="h-6 w-6" />
          </button>

          {/* Dots Indicator */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex gap-2">
            {heroSlides.map((_, index) => (
              <button
                key={index}
                aria-label={`Ir a la diapositiva ${index + 1}`}
                aria-current={currentSlide === index}
                onClick={() => setCurrentSlide(index)}
                className={`w-3 h-3 rounded-full transition-all ${currentSlide === index
                  ? 'bg-white w-8'
                  : 'bg-white/50 hover:bg-white/70'
                  }`}
              />
            ))}
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-20 px-4 bg-gradient-to-br from-primary via-primary-glow to-orange">
          <div className="container mx-auto max-w-4xl text-center">
            <div className="bg-background/10 backdrop-blur-lg rounded-3xl p-12 border border-white/20">
              <Sparkles className="w-16 h-16 text-white mx-auto mb-6" />
              <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">
                ¿Listo para comenzar tu viaje deportivo?
              </h2>
              <p className="text-lg text-white/90 mb-8 max-w-2xl mx-auto">
                Únete a miles de deportistas, padres y escuelas que ya están transformando
                el deporte en Colombia con SportMaps.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button
                  variant="elevation"
                  size="xl"
                  className="bg-white text-black hover:bg-white/90"
                  asChild
                >
                  <Link to="/register">
                    <Calendar className="w-5 h-5 mr-2" />
                    Registrarse Gratis
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  size="xl"
                  className="border-white text-white hover:bg-white/10"
                  onClick={() => navigate("/explore")}
                >
                  <MapPin className="w-5 h-5 mr-2" />
                  Explorar Escuelas
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Footer Info */}
        <section className="py-12 bg-muted/30 border-t">
          <div className="container mx-auto px-4">
            <div className="grid md:grid-cols-4 gap-8 text-center">
              <div>
                <h4 className="font-bold mb-2">Soporte 24/7</h4>
                <p className="text-sm text-muted-foreground">Estamos aquí para ayudarte en cualquier momento</p>
              </div>
              <div>
                <h4 className="font-bold mb-2">Pagos Seguros</h4>
                <p className="text-sm text-muted-foreground">Todas las transacciones son 100% seguras</p>
              </div>
              <div>
                <h4 className="font-bold mb-2">Garantía de Calidad</h4>
                <p className="text-sm text-muted-foreground">Escuelas y proveedores verificados</p>
              </div>
              <div>
                <button
                  onClick={() => {/* FAQ section - to be implemented */ }}
                  className="flex flex-col items-center gap-2 mx-auto group"
                >
                  <HelpCircle className="h-6 w-6 text-primary group-hover:scale-110 transition-transform" />
                  <h4 className="font-bold">Preguntas Frecuentes</h4>
                  <p className="text-sm text-muted-foreground">¿Necesitas ayuda?</p>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Final Footer with Slogan */}
        <footer className="py-8 bg-background border-t">
          <div className="container mx-auto px-4">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <img src={logoImage} alt="SportMaps" className="h-8 w-8" />
                <span className="font-bold font-poppins text-lg">SportMaps</span>
              </div>

              <p className="text-center font-poppins text-primary font-semibold text-lg">
                Revolucionando el sistema deportivo
              </p>

              <div className="flex items-center gap-4">
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Facebook className="h-5 w-5" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Instagram className="h-5 w-5" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Twitter className="h-5 w-5" />
                </a>
                <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                  <Youtube className="h-5 w-5" />
                </a>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t text-center text-sm text-muted-foreground">
              <p>© 2024 SportMaps. Todos los derechos reservados.</p>
              <p className="mt-1">Bogotá, Colombia | soporte@sportmaps.co</p>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
};

export default Landing;
