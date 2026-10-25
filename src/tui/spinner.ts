/**
 * The working indicator: a Pac-Man chomping a lane of dots in the b4agent
 * gradient, and a rotating Turkish word with a colour wave running through it.
 * Custom frames and the working message are drawn verbatim by Pi, so both
 * carry their own truecolor ANSI.
 */
import { existsSync, readFileSync } from "node:fs";

/** Banner gradient: carbon cyan #08BDBA to light green #6FDC8C. */
export const GRADIENT_FROM: readonly [number, number, number] = [0x08, 0xbd, 0xba];
export const GRADIENT_TO: readonly [number, number, number] = [0x6f, 0xdc, 0x8c];

export const PACMAN_INTERVAL_MS = 120;
export const WAVE_MS = 120;
export const ROTATE_MS = 6000;
/** Long-run charms join the word pool after this much continuous work. */
export const CHARM_AFTER_MS = 10_000;

const RESET_FG = "\x1b[39m";

/** One frame of the 7-cell run; `hold` repeats it, `punch` brightens it (bites and the power pellet). */
interface RunFrame {
  glyph: string;
  hold?: number;
  punch?: number;
}

const RUN: RunFrame[] = [
  // eastbound: chomp the lane, mouth open (ᗧ) and closed (○) in turn
  { glyph: "ᗧ·····•", punch: 0.05 },
  { glyph: " ○····•" },
  { glyph: " ᗧ····•", punch: 0.05 },
  { glyph: "  ○···•" },
  { glyph: "  ᗧ···•", punch: 0.05 },
  { glyph: "   ○··•" },
  { glyph: "   ᗧ··•", punch: 0.05 },
  { glyph: "    ○·•" },
  { glyph: "    ᗧ·•", punch: 0.05 },
  { glyph: "     ○•" },
  { glyph: "     ᗧ•", punch: 0.08 },
  // the power pellet at the wall: a big bite that lingers
  { glyph: "      ᗧ", hold: 2, punch: 0.25 },
  { glyph: "      ○", hold: 2, punch: 0.12 },
  // westbound over fresh dots
  { glyph: "•·····ᗤ", punch: 0.05 },
  { glyph: "•····○ " },
  { glyph: "•····ᗤ ", punch: 0.05 },
  { glyph: "•···○  " },
  { glyph: "•···ᗤ  ", punch: 0.05 },
  { glyph: "•··○   " },
  { glyph: "•··ᗤ   ", punch: 0.05 },
  { glyph: "•·○    " },
  { glyph: "•·ᗤ    ", punch: 0.05 },
  { glyph: "•○     " },
  { glyph: "•ᗤ     ", punch: 0.08 },
  { glyph: "ᗤ      ", hold: 2, punch: 0.25 },
  { glyph: "○      ", hold: 2, punch: 0.12 },
];

/** Truecolor foreground at `t` (0..1) along the gradient. */
export function gradientColor(t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const [r, g, b] = GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i]! - from) * k));
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** The full lap, each frame coloured: a slow breath along the gradient plus the bite's punch. */
export function pacmanFrames(): string[] {
  const flat: { glyph: string; punch: number }[] = [];
  for (const f of RUN) {
    const hold = Math.max(1, f.hold ?? 1);
    // The punch peaks on the first frame of a hold and eases off while it lingers.
    for (let h = 0; h < hold; h++) flat.push({ glyph: f.glyph, punch: (f.punch ?? 0) * (1 - h / (hold + 0.5)) });
  }
  return flat.map(({ glyph, punch }, i) => `${gradientColor(0.45 + 0.35 * Math.sin((2 * Math.PI * i) / flat.length) + punch)}${glyph}${RESET_FG}`);
}

/** The word with a bright crest moving left to right as `tick` grows, then a dim hint. */
export function waveText(word: string, tick: number, hint = "esc to interrupt"): string {
  const chars = Array.from(word);
  const period = Math.max(8, chars.length);
  let out = "";
  for (let i = 0; i < chars.length; i++) out += `${gradientColor(0.5 + 0.5 * Math.sin((2 * Math.PI * (i - tick)) / period))}${chars[i]}`;
  return `${out}${RESET_FG}\x1b[2m… (${hint})\x1b[22m`;
}

/** One entry per line; blank lines and `#` comments are skipped. */
export function parseWordList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The first of `paths` that exists and has entries, else `fallback`. */
export function loadWordList(paths: string[], fallback: readonly string[]): string[] {
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const words = parseWordList(readFileSync(p, "utf8"));
      if (words.length) return words;
    } catch {
      // try the next one
    }
  }
  return [...fallback];
}

/** A random pick that never repeats the previous one (when there is a choice). */
export function pickWord(pool: readonly string[], last: string | undefined, random = Math.random): string {
  if (pool.length <= 1) return pool[0] ?? WORDS[0]!;
  const choices = pool.filter((w) => w !== last);
  return choices[Math.floor(random() * choices.length)] ?? choices[0]!;
}

/** Overridable with `<agent dir>/spinner-words.txt`. */
export const WORDS: readonly string[] = [
  "Başarıyorum",
  "Harekete geçiyorum",
  "Gerçekleştiriyorum",
  "Pişiriyorum",
  "Bip bop yapıyorum",
  "Demletiyorum",
  "Hesaplıyorum",
  "Beyin fırtınası yapıyorum",
  "Kanalize ediyorum",
  "Çırpıyorum",
  "Birleştiriyorum",
  "Kafa yoruyorum",
  "Düzenliyorum",
  "Bilgisayarlıyorum",
  "Hazırlıyorum",
  "Büyü yapıyorum",
  "Değerlendiriyorum",
  "Tefekkür ediyorum",
  "Aşçılık yapıyorum",
  "Şekillendiriyorum",
  "Deşifre ediyorum",
  "Müzakere ediyorum",
  "Belirliyorum",
  "Karıştırıyorum",
  "Kehanette bulunuyorum",
  "Yapıyorum",
  "Etkiliyorum",
  "Aydınlatıyorum",
  "Büyülüyorum",
  "Tasavvur ediyorum",
  "Ayarlıyorum",
  "Zıpırlıyorum",
  "Dövüyorum",
  "Biçimlendiriyorum",
  "Eğleniyorum",
  "Üretiyorum",
  "Filizleniyorum",
  "Sürü güdüyorum",
  "Korna çalıyorum",
  "Koşturuyorum",
  "Fikir üretiyorum",
  "Hayal ediyorum",
  "Kuluçkalıyorum",
  "Çıkarım yapıyorum",
  "Dans ediyorum",
  "Tezahür ettiriyorum",
  "Marine ediyorum",
  "Dolanıyorum",
  "Geziniyorum",
  "Kafamda çeviriyorum",
  "Topluyorum",
  "Dalıyorum",
  "Kafayı çalıştırıyorum",
  "Süzüyorum",
  "İnceliyorum",
  "Felsefe yapıyorum",
  "Tartıyorum",
  "Nutuk çekiyorum",
  "İşliyorum",
  "Oyalanıyorum",
  "Bulmaca çözüyorum",
  "Ağ örüyorum",
  "Plan kuruyorum",
  "Sürükleniyorum",
  "Sallanıyorum",
  "Soyuyorum",
  "Ağır ağır pişiriyorum",
  "Eziyorum",
  "Mağara geziyorum",
  "Döndürüyorum",
  "Güveç yapıyorum",
  "Anlam çıkarıyorum",
  "Sentezliyorum",
  "Düşünüyorum",
  "Kurcalıyorum",
  "Dönüştürüyorum",
  "Açılıyorum",
  "Çözüyorum",
  "Titreşiyorum",
  "Geziyorum",
  "Vızıldıyorum",
  "Titriyorum",
  "Büyücülük yapıyorum",
  "Çalışıyorum",
  "Güreşiyorum",
];

/** Join the pool after `CHARM_AFTER_MS`. Overridable with `<agent dir>/spinner-charms.txt`. */
export const CHARMS: readonly string[] = [
  "Hâlâ pişiyor",
  "Boşluğa nazikçe soruyorum",
  "Kenarları parlatıyorum",
  "Derin bir nefes alıyorum",
  "Kabloları kontrol ediyorum",
  "Bitler yerine oturuyor",
  "Elektronlar hizaya giriyor",
  "Son rötuşları atıyorum",
  "Termal macunu tazeliyorum",
  "Daha derine iniyorum",
  "Az kaldı gibi hissediyorum",
  "Kafayı topluyorum",
];
