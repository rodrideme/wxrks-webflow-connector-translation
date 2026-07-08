import { useEffect, useState } from "react";

const PHRASES = [
  "Counting every last word…",
  "Herding CMS items into a queue…",
  "Waking up the translation hamsters…",
  "Untangling rich text fields…",
  "Politely asking Webflow for more…",
  "Reticulating collection splines…",
  "Sorting pages by vibes…",
  "Warming up the word counter…",
  "Convincing components to hold still…",
  "Double-checking locales twice…",
];

/**
 * Centered loading placeholder for content areas that can take a while to
 * populate (fetching every collection's items for "All content", or a big
 * collection's item list) -- replaces a bare "Loading…" string with a
 * lightweight CSS-only orbit animation and a rotating phrase, so a slow
 * Webflow site doesn't read as a stalled/broken page.
 */
export default function LoadingState({ label = "Loading" }) {
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * PHRASES.length));

  useEffect(() => {
    const id = setInterval(() => setPhraseIndex((i) => (i + 1) % PHRASES.length), 2400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="relative h-11 w-11">
        <span className="loading-orbit-a absolute left-1/2 top-1/2 h-2 w-2 -ml-1 -mt-1 rounded-full bg-accent" />
        <span className="loading-orbit-b absolute left-1/2 top-1/2 h-1.5 w-1.5 -ml-[3px] -mt-[3px] rounded-full bg-accent opacity-60" />
        <span className="loading-orbit-c absolute left-1/2 top-1/2 h-1 w-1 -ml-0.5 -mt-0.5 rounded-full bg-accent opacity-40" />
      </div>
      <div>
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="mt-1 text-[12px] text-ink-faint">{PHRASES[phraseIndex]}</div>
      </div>
    </div>
  );
}
