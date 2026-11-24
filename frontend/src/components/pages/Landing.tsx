import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  MapPin,
  Heart,
  ShoppingBag,
  Dumbbell,
  School,
  Calendar,
  Sparkles,
  ArrowRight,
  Search,
  Facebook,
  Instagram,
  Twitter,
  Linkedin,
  HelpCircle,
  Phone,
  ChevronRight,
  ChevronLeft,
  Pause,
  Play,
} from "lucide-react";
import heroImage from "@/assets/hero-sportsmaps.jpg";
import logoImage from "@/assets/logo-bienvenida.png";
import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SALES_PHONE_TEL, SALES_PHONE_DISPLAY } from "@/lib/salesContact";
import { SHOW_EXPLORE } from "@/lib/feature-flags";

// Redes oficiales: mismas URLs que SportMapsFooter. Nada de href="#".
const SOCIAL_LINKS = [
  { icon: Facebook, label: "Facebook", href: "https://www.facebook.com/profile.php?id=61583784419106" },
  { icon: Instagram, label: "Instagram", href: "https://www.instagram.com/sportmaps_app/" },
  { icon: Twitter, label: "X", href: "https://x.com/spoort_maps" },
  { icon: Linkedin, label: "LinkedIn", href: "https://www.linkedin.com/company/sportmaps/" },
];

const SLIDE_MS = 5000;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SocialLinks = ({ iconClass }: { iconClass: string }) => (
  <>
    {SOCIAL_LINKS.map(({ icon: Icon, label, href }) => (
      <a
        key={label}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`SportMaps en ${label}`}
        className="inline-flex items-center justify-center min-w-touch min-h-touch md:min-w-0 md:min-h-0 md:p-1 rounded-full text-muted-foreground hover:text-primary transition-colors"
      >
        <Icon className={iconClass} />
      </a>
    ))}
  </>
);

const Landing = () => {
  const navigate = useNavigate();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  // El carrusel se detiene con el mouse encima, con foco dentro, por botón
  // (WCAG 2.2.2) y nunca arranca solo si el sistema pide menos movimiento.
  const [hoverOrFocus, setHoverOrFocus] = useState(false);
  const [pausedByUser, setPausedByUser] = useState(() => prefersReducedMotion());

  const heroSlides = [
    {
      title: "Nada desde $15.000",
      subtitle: "Reserva ahora tu práctica libre",
      cta: "Reservar Ahora",
      action: () => navigate("/explore"),
      gradient: "from-primary/90 to-primary/70",
    },
    {
      title: "Fútbol como los grandes",
      subtitle: "Escuelas deportivas para todas las edades",
      cta: "Ver Escuelas",
      action: () => navigate("/explore"),
      gradient: "from-primary/90 via-primary/80 to-orange/70",
    },
    {
      title: "Equipamiento profesional",
      subtitle: "Las mejores marcas al mejor precio",
      cta: "Ir a Tienda",
      action: () => navigate("/shop"),
      gradient: "from-orange/90 to-orange-dark/70",
    },
  ];

  const quickLinks = [
    { icon: School, label: "Escuelas Deportivas", action: () => navigate("/explore") },
    { icon: Dumbbell, label: "Prácticas Libres", action: () => navigate("/explore") },
    { icon: Heart, label: "Planes de Gimnasio", action: () => navigate("/wellness") },
    { icon: ShoppingBag, label: "Tienda", action: () => navigate("/shop") },
  ];

  const total = heroSlides.length;
  const nextSlide = useCallback(() => setCurrentSlide((prev) => (prev + 1) % total), [total]);
  const prevSlide = () => setCurrentSlide((prev) => (prev - 1 + total) % total);
  const autoplay = !pausedByUser && !hoverOrFocus;

  useEffect(() => {
    if (!autoplay) return;
    const interval = setInterval(nextSlide, SLIDE_MS);
    return () => clearInterval(interval);
  }, [autoplay, nextSlide]);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    navigate(q ? `/explorar?q=${encodeURIComponent(q)}` : "/explorar");
  };

  const slide = heroSlides[currentSlide];

  return (
    <div className="bg-background">
      {/* Barra superior: contacto y redes */}
      <div className="bg-primary/10 border-b">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between min-h-10 text-sm">
            <a
              href={SALES_PHONE_TEL}
              aria-label={`Llamar a ventas ${SALES_PHONE_DISPLAY}`}
              className="flex items-center gap-2 min-h-touch min-w-touch md:min-h-0 md:min-w-0 text-foreground/80 hover:text-primary transition-colors"
            >
              <Phone className="h-4 w-4" />
              <span className="hidden md:inline">{SALES_PHONE_DISPLAY}</span>
            </a>
            <div className="flex items-center gap-1 md:gap-3">
              <SocialLinks iconClass="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b shadow-sm sticky-safe">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-20 gap-2">
            <Link to="/" className="flex items-center gap-2 shrink-0" aria-label="SportMaps, inicio">
              <img src={logoImage} alt="" className="w-12 h-12 rounded-xl" />
              <div className="hidden md:block">
                <div className="font-bold text-xl text-foreground">SportMaps</div>
                <div className="text-xs brand-slogan">Revolucionando el sistema deportivo</div>
              </div>
            </Link>

            {/* Búsqueda: solo si Explorar está activo (si no, llevaría a «muy pronto») */}
            {SHOW_EXPLORE && (
              <form role="search" onSubmit={onSearch} className="flex-1 max-w-xl mx-8 hidden lg:block">
                <label htmlFor="landing-search" className="sr-only">
                  Buscar escuelas, tiendas o servicios
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" aria-hidden />
                  <Input
                    id="landing-search"
                    type="search"
                    placeholder="Busca escuelas, tiendas o servicios..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-11 bg-muted/30 border-muted"
                  />
                </div>
              </form>
            )}

            <div className="flex items-center gap-1 sm:gap-3">
              <ThemeToggle />
              <Button variant="ghost" size="sm" onClick={() => navigate("/shop")} className="hidden md:flex">
                <ShoppingBag className="h-4 w-4 mr-2" />
                Tienda
              </Button>
              <Button variant="ghost" size="sm" asChild className="h-touch md:h-9">
                <Link to="/login">Ingresar</Link>
              </Button>
              {/* Texto oscuro sobre naranja: blanco da 2.1:1 (DESIGN.md §2) */}
              <Button variant="orange" size="sm" asChild className="h-touch md:h-9 text-text-light-primary font-semibold">
                <Link to="/register">Registrarse</Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* Accesos rápidos */}
        <nav aria-label="Accesos rápidos" className="bg-background border-b">
          <div className="container mx-auto px-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 py-4">
              {quickLinks.map((link) => {
                const Icon = link.icon;
                return (
                  <button
                    key={link.label}
                    type="button"
                    onClick={link.action}
                    className="flex flex-col items-center gap-2 p-4 rounded-lg hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all group"
                  >
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 group-hover:scale-110 transition-all">
                      <Icon className="h-6 w-6 text-primary" aria-hidden />
                    </div>
                    <span className="text-sm font-medium text-center">{link.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section
          aria-roledescription="carrusel"
          aria-label="Destacados"
          className="relative h-[70dvh] min-h-[28rem] overflow-hidden"
          onMouseEnter={() => setHoverOrFocus(true)}
          onMouseLeave={() => setHoverOrFocus(false)}
          onFocus={() => setHoverOrFocus(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoverOrFocus(false);
          }}
        >
          {/* Las tres diapositivas comparten la foto: una sola <img>, prioridad alta (LCP) */}
          <img
            src={heroImage}
            alt=""
            fetchPriority="high"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover"
          />
          {heroSlides.map((s, index) => (
            <div
              key={s.title}
              aria-hidden
              className={`absolute inset-0 bg-gradient-to-r ${s.gradient} transition-opacity duration-700 ${currentSlide === index ? "opacity-100" : "opacity-0"}`}
            />
          ))}

          {/* En dark el --primary es más claro (45%): sin este velo el blanco da ~2.8:1 */}
          <div aria-hidden className="absolute inset-0 hidden dark:block bg-black/40" />

          <div className="container relative z-10 h-full flex items-center px-4 md:px-20">
            <div className="max-w-2xl text-white" aria-live={autoplay ? "off" : "polite"}>
              <div key={currentSlide} className="animate-fade-in">
                <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold mb-4">{slide.title}</h1>
                <p className="text-lg sm:text-xl md:text-2xl mb-8 text-white/90">{slide.subtitle}</p>
                <Button
                  size="xl"
                  className="w-full sm:w-auto px-6 sm:px-12 bg-white text-black hover:bg-white/90 shadow-2xl"
                  onClick={slide.action}
                >
                  {slide.cta}
                  <ArrowRight className="ml-2 h-5 w-5" aria-hidden />
                </Button>
              </div>
            </div>
          </div>

          {/* Flechas: en móvil se ocultan (tapaban el subtítulo); se navega con los puntos */}
          <button
            type="button"
            aria-label="Diapositiva anterior"
            onClick={prevSlide}
            className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-black/20 backdrop-blur-sm border border-white/30 items-center justify-center text-white hover:bg-black/30 transition-all"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            aria-label="Diapositiva siguiente"
            onClick={nextSlide}
            className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-black/20 backdrop-blur-sm border border-white/30 items-center justify-center text-white hover:bg-black/30 transition-all"
          >
            <ChevronRight className="h-6 w-6" />
          </button>

          {/* Puntos + pausa. Cada punto tiene un área táctil de 44px aunque se vea chico */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center">
            {heroSlides.map((s, index) => (
              <button
                key={s.title}
                type="button"
                aria-label={`Ir a la diapositiva ${index + 1}: ${s.title}`}
                aria-current={currentSlide === index}
                onClick={() => setCurrentSlide(index)}
                className="w-touch h-touch flex items-center justify-center group"
              >
                <span
                  className={`block h-3 rounded-full transition-all ${currentSlide === index ? "bg-white w-8" : "w-3 bg-white/60 group-hover:bg-white/80"}`}
                />
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPausedByUser((p) => !p)}
              aria-label={pausedByUser ? "Reanudar carrusel" : "Pausar carrusel"}
              className="w-touch h-touch flex items-center justify-center text-white/90 hover:text-white"
            >
              {pausedByUser ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 md:py-20 px-4 bg-gradient-to-br from-primary via-primary-glow to-orange">
          <div className="container mx-auto max-w-4xl text-center">
            <div className="bg-background/10 dark:bg-black/40 backdrop-blur-lg rounded-3xl p-6 sm:p-12 border border-white/20">
              <Sparkles className="w-16 h-16 text-white mx-auto mb-6" aria-hidden />
              <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">¿Listo para comenzar tu viaje deportivo?</h2>
              <p className="text-lg text-white/90 mb-8 max-w-2xl mx-auto">
                Únete a miles de deportistas, padres y escuelas que ya están transformando el deporte en Colombia con
                SportMaps.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button size="xl" className="w-full sm:w-auto px-6 sm:px-10 bg-white text-black hover:bg-white/90" asChild>
                  <Link to="/register">
                    <Calendar className="w-5 h-5 mr-2" aria-hidden />
                    Registrarse Gratis
                  </Link>
                </Button>
                {/* bg-transparent: la variante outline trae bg-background y el texto blanco quedaba invisible */}
                <Button
                  variant="outline"
                  size="xl"
                  className="w-full sm:w-auto px-6 sm:px-10 bg-transparent border-white text-white hover:bg-white/10 hover:text-white"
                  onClick={() => navigate("/explore")}
                >
                  <MapPin className="w-5 h-5 mr-2" aria-hidden />
                  Explorar Escuelas
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Garantías */}
        <section className="py-12 bg-muted/30 border-t">
          <div className="container mx-auto px-4">
            <div className="grid md:grid-cols-4 gap-8 text-center">
              <div>
                <h3 className="font-bold mb-2">Soporte 24/7</h3>
                <p className="text-sm text-foreground/75">Estamos aquí para ayudarte en cualquier momento</p>
              </div>
              <div>
                <h3 className="font-bold mb-2">Pagos Seguros</h3>
                <p className="text-sm text-foreground/75">Todas las transacciones son 100% seguras</p>
              </div>
              <div>
                <h3 className="font-bold mb-2">Garantía de Calidad</h3>
                <p className="text-sm text-foreground/75">Escuelas y proveedores verificados</p>
              </div>
              <div>
                <Link
                  to="/ayuda"
                  className="flex flex-col items-center gap-2 mx-auto group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <HelpCircle className="h-6 w-6 text-primary group-hover:scale-110 transition-transform" aria-hidden />
                  <h3 className="font-bold">Preguntas Frecuentes</h3>
                  <p className="text-sm text-foreground/75">¿Necesitas ayuda?</p>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-8 bg-background border-t">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src={logoImage} alt="" className="h-8 w-8" />
              <span className="font-bold font-poppins text-lg">SportMaps</span>
            </div>
            <p className="text-center font-poppins text-primary font-semibold text-lg">Revolucionando el sistema deportivo</p>
            <div className="flex items-center gap-1 md:gap-4">
              <SocialLinks iconClass="h-5 w-5" />
            </div>
          </div>

          <div className="mt-6 pt-6 border-t text-center text-sm text-foreground/75">
            <p>© {new Date().getFullYear()} SportMaps. Todos los derechos reservados.</p>
            <p className="mt-1">
              Bogotá, Colombia |{" "}
              <a href="mailto:soporte@sportmaps.co" className="underline-offset-2 hover:underline hover:text-primary">
                soporte@sportmaps.co
              </a>
            </p>
            <p className="mt-2 flex flex-wrap justify-center gap-x-4">
              <Link to="/terminos-y-condiciones" className="inline-flex items-center min-h-touch md:min-h-0 hover:text-primary hover:underline underline-offset-2">
                Términos y condiciones
              </Link>
              <Link to="/politica-de-privacidad" className="inline-flex items-center min-h-touch md:min-h-0 hover:text-primary hover:underline underline-offset-2">
                Política de privacidad
              </Link>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
