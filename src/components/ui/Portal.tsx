import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Render `children` into `document.body` so fixed-position dialogs aren't
 * affected by transformed/filtered ancestors (the sidebar uses backdrop-blur
 * and framer-motion `layoutId` transforms, both of which create a containing
 * block that traps `position: fixed`).
 */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
