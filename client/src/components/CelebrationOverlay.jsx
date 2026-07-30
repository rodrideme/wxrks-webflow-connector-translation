import { useEffect, useMemo, useRef } from "react";

/**
 * Full-screen "project created" celebration: a traditional confetti burst
 * where the pieces are letters from many of the world's scripts (it's a
 * translation product -- paper rectangles felt off-brand), behind a big
 * random congratulations line. Canvas + one rAF loop, no animation
 * library. Auto-dismisses after a few seconds; any click skips it.
 */

const MESSAGES = [
  "Your content is learning a new language faster than most of us.",
  "The hard part is over. Probably.",
  "It’s happening. Your content is going multilingual.",
  "That was easy. Almost suspiciously easy.",
  "Now let’s make it wxrks!",
  "Looks like everything wxrks.",
  "Good news: it wxrks.",
  "Let’s make this wxrks.",
];

// Plain letters only (no symbols), spanning Latin, Greek, Cyrillic,
// Arabic, Hebrew, Devanagari, Han, Kana, Hangul, Thai, Georgian,
// Armenian, Ethiopic, Tamil and Bengali.
const GLYPHS = [
  "A", "ñ", "é", "ß", "ø",
  "Ω", "λ", "Σ", "ψ", "π",
  "Я", "Ж", "Д", "Б",
  "ض", "ش", "ع",
  "א", "ש", "מ",
  "अ", "क", "भ",
  "语", "文", "字", "译",
  "あ", "ら", "ん", "カ",
  "한", "글", "어",
  "ก", "ฬ",
  "ღ", "ჯ",
  "Ա", "բ",
  "አ", "በ",
  "அ", "ழ",
  "অ",
];

const COLORS = ["#f43f5e", "#f97316", "#eab308", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

const PARTICLE_COUNT = 150;
const BURST_DURATION_MS = 3200;
const BURST_FADE_MS = 700;
const AUTO_DISMISS_MS = 4500;

export default function CelebrationOverlay({ open, onClose }) {
  const canvasRef = useRef(null);
  // Kept in a ref so the timer/animation effects only re-arm on open/close,
  // not every parent render (the inline onClose prop has a new identity
  // each time).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const message = useMemo(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)], [open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = setTimeout(() => onCloseRef.current?.(), AUTO_DISMISS_MS);
    return () => clearTimeout(dismiss);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Motion is the enhancement, not the content -- under reduced motion
    // skip the confetti entirely and just show the message.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const particles = Array.from({ length: PARTICLE_COUNT }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 12;
      return {
        x: width / 2,
        y: height * 0.44,
        vx: Math.cos(angle) * speed,
        // Upward bias so the burst blooms above the message before gravity
        // rains it down past it.
        vy: Math.sin(angle) * speed - 6,
        glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: 13 + Math.random() * 17,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.28,
      };
    });

    let start = null;
    let raf = requestAnimationFrame(function frame(now) {
      if (start === null) start = now;
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha =
        elapsed > BURST_DURATION_MS - BURST_FADE_MS ? Math.max(0, (BURST_DURATION_MS - elapsed) / BURST_FADE_MS) : 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const p of particles) {
        p.vy += 0.16; // gravity
        p.vx *= 0.99; // air drag
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.font = `700 ${p.size}px system-ui, sans-serif`;
        ctx.fillText(p.glyph, 0, 0);
        ctx.restore();
      }
      if (elapsed < BURST_DURATION_MS) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, width, height);
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="celebration-veil fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      style={{ backgroundColor: "color-mix(in srgb, var(--surface) 82%, transparent)" }}
      onClick={onClose}
      role="status"
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />
      <div className="celebration-pop relative px-6 text-center">
        <div className="text-6xl font-bold tracking-tight text-ink">Congrats.</div>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-ink-soft">Project created. {message}</p>
      </div>
    </div>
  );
}
