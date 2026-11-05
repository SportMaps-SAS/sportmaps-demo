import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

export interface PhoneCountry {
  /** ISO 3166-1 alfa-2 (identifica al país; el indicativo se comparte, p. ej. +1 o +7). */
  iso: string;
  label: string;
  /** Indicativo con «+», p. ej. «+57». */
  value: string;
  flag: string;
}

// ISO → indicativo. Los países del plan NANP (EE. UU., Canadá, Caribe) comparten «+1»:
// el código de área va dentro del número que escribe la persona.
const DIAL_CODES = `AF 93,AL 355,DZ 213,AS 1,AD 376,AO 244,AI 1,AG 1,AR 54,AM 374,AW 297,AU 61,AT 43,AZ 994,BS 1,BH 973,BD 880,BB 1,BY 375,BE 32,BZ 501,BJ 229,BM 1,BT 975,BO 591,BA 387,BW 267,BR 55,IO 246,VG 1,BN 673,BG 359,BF 226,BI 257,KH 855,CM 237,CA 1,CV 238,KY 1,CF 236,TD 235,CL 56,CN 86,CO 57,KM 269,CG 242,CD 243,CK 682,CR 506,CI 225,HR 385,CU 53,CW 599,CY 357,CZ 420,DK 45,DJ 253,DM 1,DO 1,EC 593,EG 20,SV 503,GQ 240,ER 291,EE 372,SZ 268,ET 251,FK 500,FO 298,FJ 679,FI 358,FR 33,GF 594,PF 689,GA 241,GM 220,GE 995,DE 49,GH 233,GI 350,GR 30,GL 299,GD 1,GP 590,GU 1,GT 502,GG 44,GN 224,GW 245,GY 592,HT 509,HN 504,HK 852,HU 36,IS 354,IN 91,ID 62,IR 98,IQ 964,IE 353,IM 44,IL 972,IT 39,JM 1,JP 81,JE 44,JO 962,KZ 7,KE 254,KI 686,XK 383,KW 965,KG 996,LA 856,LV 371,LB 961,LS 266,LR 231,LY 218,LI 423,LT 370,LU 352,MO 853,MG 261,MW 265,MY 60,MV 960,ML 223,MT 356,MH 692,MQ 596,MR 222,MU 230,YT 262,MX 52,FM 691,MD 373,MC 377,MN 976,ME 382,MS 1,MA 212,MZ 258,MM 95,NA 264,NR 674,NP 977,NL 31,NC 687,NZ 64,NI 505,NE 227,NG 234,NU 683,NF 672,KP 850,MK 389,MP 1,NO 47,OM 968,PK 92,PW 680,PS 970,PA 507,PG 675,PY 595,PE 51,PH 63,PL 48,PT 351,PR 1,QA 974,RE 262,RO 40,RU 7,RW 250,BL 590,SH 290,KN 1,LC 1,MF 590,PM 508,VC 1,WS 685,SM 378,ST 239,SA 966,SN 221,RS 381,SC 248,SL 232,SG 65,SX 1,SK 421,SI 386,SB 677,SO 252,ZA 27,KR 82,SS 211,ES 34,LK 94,SD 249,SR 597,SE 46,CH 41,SY 963,TW 886,TJ 992,TZ 255,TH 66,TL 670,TG 228,TK 690,TO 676,TT 1,TN 216,TR 90,TM 993,TC 1,TV 688,UG 256,UA 380,AE 971,GB 44,US 1,UY 598,VI 1,UZ 998,VU 678,VA 39,VE 58,VN 84,WF 681,EH 212,YE 967,ZM 260,ZW 263,AX 358,BQ 599`;

const flagOf = (iso: string) =>
  String.fromCodePoint(...iso.split("").map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" });
  } catch {
    return null;
  }
})();

// Los que más llegan van primero; el resto, alfabético.
const PRIORITY = ["CO", "MX", "BR", "AR", "CL", "PE", "EC", "PA", "VE", "US", "ES"];

const ALL_COUNTRIES: PhoneCountry[] = DIAL_CODES.split(",").map((pair) => {
  const [iso, dial] = pair.split(" ");
  let label = iso;
  try {
    label = regionNames?.of(iso) || iso;
  } catch {
    /* código sin nombre: se muestra el ISO */
  }
  return { iso, label, value: "+" + dial, flag: flagOf(iso) };
});

export const COUNTRIES: PhoneCountry[] = [
  ...PRIORITY.map((iso) => ALL_COUNTRIES.find((c) => c.iso === iso)!),
  ...ALL_COUNTRIES.filter((c) => !PRIORITY.includes(c.iso)).sort((a, b) =>
    a.label.localeCompare(b.label, "es"),
  ),
];

/** Nombre histórico: ahora son todos los países del mundo. */
export const LATAM_COUNTRIES = COUNTRIES;

/** País cuyo indicativo es el prefijo MÁS LARGO de `value` (+593 gana sobre +5…). */
export function countryForPhone(value: string): PhoneCountry | undefined {
  let best: PhoneCountry | undefined;
  for (const c of COUNTRIES) {
    if (value.startsWith(c.value) && (!best || c.value.length > best.value.length)) best = c;
  }
  return best;
}

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

export function PhoneInput({ value, onChange, placeholder, className, disabled, id }: PhoneInputProps) {
  const [open, setOpen] = React.useState(false);

  // El país elegido se recuerda por ISO: +1 sirve para varios países y +7 para dos.
  const [pickedIso, setPickedIso] = React.useState<string | null>(null);

  const selectedCountry = React.useMemo(() => {
    const picked = pickedIso ? COUNTRIES.find((c) => c.iso === pickedIso) : undefined;
    if (picked && value.startsWith(picked.value)) return picked;
    return countryForPhone(value) || COUNTRIES[0];
  }, [value, pickedIso]);

  const rawNumber = value.startsWith(selectedCountry.value) 
    ? value.slice(selectedCountry.value.length) 
    : value;

  const handleCountryChange = (iso: string) => {
    const newCountry = COUNTRIES.find((c) => c.iso === iso);
    if (newCountry) {
      setPickedIso(newCountry.iso);
      onChange(newCountry.value + rawNumber);
    }
    setOpen(false);
  };

  const handleNumberChange = (newNumber: string) => {
    // Only allow digits
    const cleanNumber = newNumber.replace(/\D/g, "");
    onChange(selectedCountry.value + cleanNumber);
  };

  return (
    <div className={cn("flex gap-0 group h-11 bg-background/50 border border-border/40 rounded-xl overflow-hidden focus-within:border-primary/50 transition-colors", className)}>
      <Popover open={open} onOpenChange={(o) => { if (!disabled) setOpen(o); }}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-24 h-full rounded-none border-r border-border/40 px-3 hover:bg-primary/10 transition-colors"
          >
            <span className="text-lg mr-1.5">{selectedCountry.flag}</span>
            <span className="text-xs font-bold text-muted-foreground">{selectedCountry.value}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar país..." />
            <CommandList>
              <CommandEmpty>No se encontró el país.</CommandEmpty>
              <CommandGroup>
                {COUNTRIES.map((country) => (
                  <CommandItem
                    key={country.iso}
                    value={`${country.label} ${country.value} ${country.iso}`}
                    onSelect={() => handleCountryChange(country.iso)}
                    className="cursor-pointer"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedCountry.iso === country.iso ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="mr-2">{country.flag}</span>
                    <span className="flex-1">{country.label}</span>
                    <span className="text-muted-foreground text-xs">{country.value}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Input
        id={id}
        type="tel"
        value={rawNumber}
        onChange={(e) => handleNumberChange(e.target.value)}
        placeholder={placeholder || "Número"}
        disabled={disabled}
        className="flex-1 h-full border-0 bg-transparent rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 px-4 text-base font-medium"
      />
    </div>
  );
}
