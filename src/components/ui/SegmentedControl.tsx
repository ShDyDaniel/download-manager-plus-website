import { motion } from "framer-motion";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Optional smaller text rendered next to the label (e.g. a hint). */
  sub?: string;
  /** Optional leading icon. */
  icon?: React.ReactNode;
}

// `default` is the new espresso-direction variant — solid copper
// indicator with foreground-tone text. The older `violet` / `cyan` /
// `emerald` / `subtle` names are kept for source-compat with any
// call site we haven't touched yet; they all now resolve to the
// same warm-family treatment so the palette stays cohesive even
// when an old variant string sneaks through.
type Variant = "default" | "violet" | "cyan" | "emerald" | "subtle";

const VARIANT_INDICATOR: Record<Variant, string> = {
  default: "bg-primary",
  violet: "bg-primary",
  cyan: "bg-primary",
  emerald: "bg-primary/30",
  subtle: "bg-card",
};

const VARIANT_ACTIVE_TEXT: Record<Variant, string> = {
  default: "text-primary-foreground",
  violet: "text-primary-foreground",
  cyan: "text-primary-foreground",
  emerald: "text-accent",
  subtle: "text-foreground",
};

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: Variant;
  /** Optional override for the grid container class — useful when the
   * call site needs a specific gap, padding, or width behaviour. */
  className?: string;
  /** Padding/sizing knob: "sm" for the compact pill in toolbars, "md"
   * for chunkier in-form controls. */
  size?: "sm" | "md";
}

interface IndicatorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Pill-style segmented control with a sliding indicator that animates
 * smoothly between options.
 *
 * The indicator uses **measurement-based positioning** (refs +
 * `useLayoutEffect`) rather than framer-motion's `layoutId`. The
 * `layoutId` approach was attempted earlier and turned out to be
 * load-bearing on framer-motion's global shared-layout tracker — when
 * a control was inside a page wrapped in `<AnimatePresence>`, clicking
 * an option mid-page-transition would leave the layout tracker in an
 * inconsistent state, and subsequent page switches rendered as blank
 * panels. The measurement approach is plain framer-motion `animate`
 * with no global state, so it's immune to that interaction.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  variant = "violet",
  className,
  size = "sm",
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<IndicatorRect | null>(null);
  // First render skips the spring so the highlight appears in place
  // (rather than flying in from x=0). Subsequent renders animate.
  const hasRenderedOnce = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const btn = btnRefs.current.get(value);
    if (!container || !btn) {
      setIndicator(null);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    setIndicator({
      left: bRect.left - cRect.left,
      top: bRect.top - cRect.top,
      width: bRect.width,
      height: bRect.height,
    });
  }, [value, options.length, size]);

  // Re-measure when the container resizes (e.g. layout reflows around
  // it). Without this, switching projects or resizing the window can
  // leave the indicator stuck at its old coordinates.
  //
  // We read `value` through a ref so this effect is registered once
  // (empty dep array) — otherwise the observer churned on every
  // click, creating + tearing down per render.
  const valueRef = useRef(value);
  valueRef.current = value;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const btn = btnRefs.current.get(valueRef.current);
      if (!container || !btn) return;
      const cRect = container.getBoundingClientRect();
      const bRect = btn.getBoundingClientRect();
      setIndicator({
        left: bRect.left - cRect.left,
        top: bRect.top - cRect.top,
        width: bRect.width,
        height: bRect.height,
      });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const padX = size === "md" ? "px-4 py-2" : "px-3 py-1.5";

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-grid gap-1 rounded-xl bg-white/[0.03] p-1",
        className,
      )}
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {indicator && (
        <motion.div
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-lg",
            VARIANT_INDICATOR[variant],
          )}
          style={{ left: 0, top: 0 }}
          initial={false}
          animate={{
            x: indicator.left,
            y: indicator.top,
            width: indicator.width,
            height: indicator.height,
          }}
          transition={
            hasRenderedOnce.current
              ? { type: "spring", stiffness: 380, damping: 32 }
              : { duration: 0 }
          }
          onAnimationComplete={() => {
            hasRenderedOnce.current = true;
          }}
        />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.value, el);
              else btnRefs.current.delete(opt.value);
            }}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative z-10 flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors duration-200",
              padX,
              active
                ? VARIANT_ACTIVE_TEXT[variant]
                : "text-muted-foreground hover:text-foreground/80",
            )}
          >
            {opt.icon}
            <span>{opt.label}</span>
            {opt.sub && (
              <span
                className={cn(
                  "text-[10px]",
                  active ? "text-white/70" : "text-muted-foreground/70",
                )}
              >
                {opt.sub}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
