import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Portal } from "@/components/ui/Portal";

/**
 * In-app confirmation modal — replaces `window.confirm()` so we get
 * proper RTL Hebrew, our dark theme, and consistent typography. Mounted
 * via Portal so it floats over the rest of the app at z-[300].
 *
 * Controlled component: caller owns `open` and provides callbacks for
 * confirm / cancel. The destructive variant (default) is themed in red
 * because every confirm we currently use is for an irreversible delete.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "אישור",
  cancelLabel = "ביטול",
  variant = "destructive",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, pointerEvents: "auto" }}
            exit={{ opacity: 0, pointerEvents: "none" }}
            transition={{ duration: 0.15 }}
            dir="rtl"
            onClick={onCancel}
            className="fixed inset-0 z-[300] flex items-center justify-center bg-background/80 p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.94, y: 12, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.94, y: 12, opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[min(420px,92vw)] overflow-hidden rounded-3xl border border-white/10 bg-zinc-950/95 shadow-2xl"
            >
              <div className="flex items-start gap-3 p-5">
                <div
                  className={
                    variant === "destructive"
                      ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 shadow-md shadow-rose-900/40"
                      : "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-md"
                  }
                >
                  <AlertTriangle className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1">
                  <h3 className="text-base font-bold text-foreground">{title}</h3>
                  {description && (
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {description}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 border-t border-white/5 bg-black/20 p-3">
                <Button variant="secondary" size="sm" onClick={onCancel} className="flex-1">
                  {cancelLabel}
                </Button>
                <Button
                  variant={variant === "destructive" ? "default" : "gradient"}
                  size="sm"
                  onClick={onConfirm}
                  className={
                    variant === "destructive"
                      ? "flex-1 bg-rose-600 text-white hover:bg-rose-700"
                      : "flex-1"
                  }
                >
                  {confirmLabel}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}
