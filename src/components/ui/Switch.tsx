import * as SwitchPrimitives from "@radix-ui/react-switch";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Radix Switch — squared editorial treatment, not the default
 * iOS/Material pill.
 *
 * Earlier version used `rounded-full` track + circular thumb, which
 * is the universal mobile-app default. On a desktop editorial tool
 * with a warm copper palette, that read as "off-brand component
 * pasted in from a UI kit." Two repeated full circles per toggle
 * also gave the user a "too round, too generic" reaction.
 *
 * New look:
 *   - Track: `rounded-md` (6px radius) instead of `rounded-full` —
 *     squared enough to feel intentional, soft enough to fit the
 *     warm palette. Subtle border so the off state looks "carved"
 *     into the surface rather than floating.
 *   - Thumb: `rounded-sm` (2px radius) and slightly narrower than
 *     tall, giving it a small "key" / "switch-tile" feel that
 *     reinforces the desktop-tool tone.
 *   - ON state still uses `bg-primary` (the warm copper from the
 *     palette) plus the soft halo glow the old version had, so
 *     active state still pops.
 *
 * Slide direction is governed by `translate-x` on the thumb, which
 * is a physical (not RTL-aware) transform — works identically in
 * Hebrew and English layouts. Together with `inline-flex`'s
 * direction-aware initial thumb position, the thumb naturally
 * starts on the off side and slides to the on side regardless of
 * the document's dir attribute.
 */
export const Switch = forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      "peer relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-md border transition-colors duration-300",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // OFF: muted surface + subtle border that reads as "carved
      // into" the background rather than floating on top.
      "data-[state=unchecked]:border-border data-[state=unchecked]:bg-white/[0.04]",
      // ON: copper fill + matching border so the whole track lights
      // up, plus an inset highlight for a slight depth cue.
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
      // Soft halo glow when active — same metaphor as the rest of
      // the app's "live" indicators (the project-active dot, the
      // recommendation pill). Rendered via an absolutely-positioned
      // pseudo-element rather than a Tailwind arbitrary shadow with
      // hsl(var(...)) inside parens (JIT parsing is flaky on those).
      "before:absolute before:inset-0 before:rounded-md before:bg-primary/40 before:opacity-0 before:blur-md before:transition-opacity before:duration-300",
      "data-[state=checked]:before:opacity-100",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none relative z-10 block h-3.5 w-3.5 rounded-sm bg-foreground/95 shadow-lg ring-0",
        // Smooth spring-like easing — same overshoot timing the
        // previous round-thumb version used so the muscle memory
        // for "the toggle feels snappy" carries over.
        "transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
        // Slide direction: -x is physical LEFT. Default thumb
        // position is on the visual right (RTL doc, flex-start),
        // so a leftward translate brings it to the active side
        // visually. The exact distance (4 = 16px) matches the
        // track-vs-thumb width delta (w-10 = 40px track, w-3.5 =
        // 14px thumb, leaves ~22px travel — 16px keeps a small
        // visual margin on the destination side).
        "data-[state=checked]:-translate-x-5 data-[state=unchecked]:translate-x-0",
        // ON state: the white thumb against copper track stays
        // bright, but we drop the bg slightly to a warm cream so
        // it doesn't strobe against the saturated copper.
        "data-[state=checked]:bg-background",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = "Switch";
