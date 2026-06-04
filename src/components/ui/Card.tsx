import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/* Card — base container primitive. Editorial direction: tighter
 * radius (10px = var(--radius)), warm-tinted border + bg from
 * semantic tokens. The previous version used `white/5` borders
 * which read as cool gray on the warm espresso bg; switching to
 * the border token keeps the temperature consistent. No backdrop
 * blur — it was a perf hit on long forms and the warm card bg
 * already separates from the page without it. */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-border bg-card p-5",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";
