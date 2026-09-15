import {
  Bricolage_Grotesque,
  DM_Sans,
  Fraunces,
  Geist,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Instrument_Serif,
  Manrope,
  Newsreader,
  Plus_Jakarta_Sans,
  Sora,
} from "next/font/google";

/**
 * Every font the picker can choose from. Each is self-hosted at build; with
 * `preload: false` the browser only downloads a family once something on the
 * page uses it, so offering ten costs nothing until one is picked.
 */
const geist = Geist({ variable: "--font-geist", subsets: ["latin"], preload: false, display: "swap" });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], preload: false, display: "swap" });
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], preload: false, display: "swap" });
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], preload: false, display: "swap" });
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], preload: false, display: "swap" });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], preload: false, display: "swap" });
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"], preload: false, display: "swap" });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"], preload: false, display: "swap" });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], preload: false, display: "swap" });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz", "SOFT"], style: ["normal", "italic"], preload: false, display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export interface FontOption {
  id: string;
  label: string;
  kind: "sans" | "serif";
  /** The CSS variable next/font defines for this family. */
  variable: string;
}

export const FONT_OPTIONS: FontOption[] = [
  { id: "geist", label: "Geist", kind: "sans", variable: "--font-geist" },
  { id: "manrope", label: "Manrope", kind: "sans", variable: "--font-manrope" },
  { id: "jakarta", label: "Plus Jakarta Sans", kind: "sans", variable: "--font-jakarta" },
  { id: "bricolage", label: "Bricolage Grotesque", kind: "sans", variable: "--font-bricolage" },
  { id: "sora", label: "Sora", kind: "sans", variable: "--font-sora" },
  { id: "dm-sans", label: "DM Sans", kind: "sans", variable: "--font-dm-sans" },
  { id: "plex-sans", label: "IBM Plex Sans", kind: "sans", variable: "--font-plex-sans" },
  { id: "instrument-serif", label: "Instrument Serif", kind: "serif", variable: "--font-instrument-serif" },
  { id: "newsreader", label: "Newsreader", kind: "serif", variable: "--font-newsreader" },
  { id: "fraunces", label: "Fraunces", kind: "serif", variable: "--font-fraunces" },
];

export const DEFAULT_FONTS = { heading: "geist", body: "geist", brand: "geist" };

/** Class names that define every family's CSS variable on <html>. */
export const fontClassNames = [
  geist,
  manrope,
  jakarta,
  bricolage,
  sora,
  dmSans,
  plexSans,
  instrumentSerif,
  newsreader,
  fraunces,
  plexMono,
]
  .map((f) => f.variable)
  .join(" ");

export const FONT_COOKIE = "aw_fonts";

export function optionById(id: string | undefined): FontOption | undefined {
  return FONT_OPTIONS.find((o) => o.id === id);
}

/** Parse the cookie value `heading:body:brand`, falling back per slot. */
export function parseFontCookie(value: string | undefined): { heading: FontOption; body: FontOption; brand: FontOption } {
  const [h, b, br] = (value ?? "").split(":");
  return {
    heading: optionById(h) ?? (optionById(DEFAULT_FONTS.heading) as FontOption),
    body: optionById(b) ?? (optionById(DEFAULT_FONTS.body) as FontOption),
    brand: optionById(br) ?? (optionById(DEFAULT_FONTS.brand) as FontOption),
  };
}
