import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/* Button variants — Espresso Editorial.
 *
 * Every variant resolves to semantic color tokens so a theme tweak
 * lives in index.css, not here. The previous `gradient` variant was
 * `from-violet-600 to-fuchsia-600` — a bright purple/pink gradient
 * that screamed "AI default CTA" and clashed with the new copper
 * palette. Now it's a subtle copper→caramel warm gradient that
 * stays in the brand family while keeping the variant visually
 * distinct from `default` (which is flat copper).
 *
 * `secondary` / `outline` / `ghost` swapped from `white/X` opacity
 * (cool gray on warm bg = "blue" by simultaneous contrast) to
 * warm-tinted `bg-card` / `border-border` — much better against
 * the espresso background.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "bg-card text-foreground border border-border hover:bg-popover",
        ghost: "text-foreground hover:bg-card",
        // Same name as before for source-compat; visually replaced
        // with a copper→caramel warm gradient. Used on primary CTAs
        // that deserve more weight than the default flat copper —
        // e.g. login, redeem, "buy now".
        gradient:
          "bg-gradient-to-l from-primary to-accent text-primary-foreground shadow-md hover:from-primary/95 hover:to-accent/95",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-card",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
