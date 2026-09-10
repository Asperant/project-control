import { useEffect, useRef } from 'react';

/**
 * Shared behaviour for the panel's hand-rolled `role="dialog"` overlays (see
 * MemoryView's checkpoint detail dialog and ResumeView's session dialogs) —
 * a focus trap, initial focus, Escape-to-close, and focus restoration, all
 * implemented with plain DOM APIs since the panel deliberately carries no
 * focus-trap dependency.
 *
 * `open` should reflect whether the dialog is currently shown — either
 * because the component itself is only mounted while open, or because a
 * parent toggles an `open` flag on an always-mounted dialog. `busy` guards
 * Escape the same way a backdrop click is already guarded elsewhere: a
 * dialog mid-save must not be dismissed out from under an in-flight mutation.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useModalDialog<T extends HTMLElement>({
  open,
  onClose,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
}): { containerRef: React.RefObject<T | null> } {
  const containerRef = useRef<T | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Initial focus + focus restoration: runs once per open/close transition,
  // not on every render (a busy toggle mid-dialog must not steal focus back).
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = containerRef.current;
    if (container) {
      const preferred = container.querySelector<HTMLElement>('[autofocus]') ?? focusableElements(container)[0];
      (preferred ?? container).focus();
    }

    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Focus trap + Escape-to-close.
  useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (busy) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const items = focusableElements(container);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  return { containerRef };
}
