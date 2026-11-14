import { Facebook, Instagram, Linkedin, Mail, MapPin, Phone, ShieldCheck, Twitter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { SHOW_EXPLORE } from "@/lib/feature-flags";
import { SALES_PHONE_TEL, SALES_PHONE_DISPLAY } from "@/lib/salesContact";

export function SportMapsFooter() {
  return (
    <footer className="bg-gradient-to-b from-[#1a1a2e] to-[#0f0f1a] text-gray-300 font-poppins">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">

          {/* 1. Identidad y Redes Sociales Oficiales */}
          <div className="space-y-6">
            <div className="space-y-4">
              <Link to="/" className="flex items-center gap-2">
                <img
                  src="/logo-bienvenida.png"
                  alt="SportMaps"
                  className="h-10 w-auto"
                />
                <span className="text-xl font-bold text-white">
                  SportMaps
                </span>
              </Link>
              <p className="text-sm text-gray-400 leading-relaxed">
                Revolucionando el sistema deportivo. Conectamos atletas, escuelas y profesionales en un ecosistema tecnológico unificado.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <SocialBtn icon={Facebook} href="https://www.facebook.com/profile.php?id=61583784419106" label="Facebook" />
              <SocialBtn icon={Instagram} href="https://www.instagram.com/sportmaps_app/" label="Instagram" />
              <SocialBtn icon={Twitter} href="https://x.com/spoort_maps" label="X" />
              <SocialBtn icon={Linkedin} href="https://www.linkedin.com/company/sportmaps/" label="LinkedIn" />
            </div>
          </div>

          {/* 2. Soluciones del Ecosistema */}
          <div className="space-y-4">
            <h4 className="text-white font-semibold text-lg">Ecosistema</h4>
            <ul className="space-y-3">
              <FooterLink text="Para Atletas" href="/register?role=athlete" />
              <FooterLink text="Para Padres" href="/register?role=parent" />
              <FooterLink text="Para Entrenadores" href="/register?role=coach" />
              <FooterLink text="Para Escuelas" href="/register?role=school" />
              <FooterLink text="Para Profesionales Wellness" href="/register?role=wellness" />
            </ul>
          </div>

          {/* 3. SportMaps Tech */}
          <div className="space-y-4">
            <h4 className="text-white font-semibold text-lg">SportMaps Tech</h4>
            <ul className="space-y-3">
              <FooterLink text="Marketplace" href="/shop" />
              {SHOW_EXPLORE && <FooterLink text="Explorar" href="/explorar" />}
              <FooterLink text="Blog Deportivo" href="/blog" />
              <FooterLink text="Centro de Ayuda" href="/help" />
              <FooterLink text="Zona de Partners" href="/partners" isHighlighted />
            </ul>
          </div>

          {/* 4. Contacto & Soporte Global */}
          <div className="space-y-4">
            <h4 className="text-white font-semibold text-lg">Contacto & Legal</h4>
            <ul className="space-y-3">
              <li className="flex items-start gap-3 text-sm">
                <MapPin className="h-4 w-4 mt-0.5 text-primary flex-shrink-0" />
                <span className="text-gray-400">
                  Bogotá D.C., Colombia<br />
                  <span className="text-xs text-gray-500">Sede Global Latam</span>
                </span>
              </li>
              <li className="flex items-center gap-3 text-sm">
                <Mail className="h-4 w-4 text-primary flex-shrink-0" />
                <a
                  href="mailto:contacto@sportmaps.co"
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  contacto@sportmaps.co
                </a>
              </li>
              <li className="flex items-center gap-3 text-sm">
                <Phone className="h-4 w-4 text-primary flex-shrink-0" />
                <a
                  href={SALES_PHONE_TEL}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  {SALES_PHONE_DISPLAY}
                </a>
              </li>
              <li className="flex items-center gap-4 mt-4">
                <FooterLink text="Términos y Condiciones" href="/terminos-y-condiciones" isLegal />
                <FooterLink text="Política de Privacidad" href="/politica-de-privacidad" isLegal />
              </li>
            </ul>
          </div>
        </div>

        {/* Footer Inferior */}
        <div className="mt-12 pt-8 border-t border-gray-800 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-xs text-gray-500 text-center md:text-left">
            © 2025 SportMaps Technology S.A.S. Todos los derechos reservados.
          </p>

          <div className="flex items-center gap-2 text-xs text-gray-500">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span>Sitio Seguro SSL & Pagos Protegidos por SportMaps Pay</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

// Sub-componentes
function FooterLink({
  text,
  href = "#",
  isLegal = false,
  isHighlighted = false
}: {
  text: string;
  href?: string;
  isLegal?: boolean;
  isHighlighted?: boolean;
}) {
  return (
    <li className={isLegal ? "inline" : ""}>
      <Link
        to={href}
        className={`text-sm transition-colors ${isHighlighted
            ? "text-primary hover:text-primary/80 font-medium"
            : isLegal
              ? "text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
              : "text-gray-400 hover:text-white"
          }`}
      >
        {text}
      </Link>
    </li>
  );
}

function SocialBtn({
  icon: Icon,
  href,
  label
}: {
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      asChild
      className="h-9 w-9 rounded-full bg-white/5 hover:bg-primary hover:text-white transition-all"
    >
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
        <Icon className="h-4 w-4" />
      </a>
    </Button>
  );
}
