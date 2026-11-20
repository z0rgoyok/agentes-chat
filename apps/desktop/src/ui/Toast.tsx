import { Button, Icon, type IconName } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/** The toast's one way forward ("Reopen now"): it closes the toast when pressed. */
export interface ToastAction {
  label: string;
  run: () => void;
}

type Show = (message: string, icon?: IconName, action?: ToastAction) => void;
const ToastContext = createContext<Show>(() => {});

/** One short confirmation at a time at the bottom of the window ("Pasta removida"), at most one action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{
    message: string;
    icon: IconName;
    action?: ToastAction;
    key: number;
  } | null>(null);
  const [on, setOn] = useState(false);
  const show = useCallback<Show>((message, icon = "check", action) => {
    setToast({ message, icon, action, key: Date.now() });
    setOn(true);
  }, []);
  // The shown toast's own timer: a toast asked for after the provider is gone (an action ending after its window)
  // starts none. One with an action stays long enough to reach it.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setOn(false), toast.action ? 8000 : 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <output
        className="dk-toast"
        data-on={on || undefined}
        data-action={toast?.action ? "" : undefined}
        aria-live="polite"
      >
        {toast && (
          <>
            <span className="ac-iconline">
              <Icon name={toast.icon} size={14} />
              <span>{toast.message}</span>
            </span>
            {toast.action && (
              <Button
                size="sm"
                className="dk-toast__act"
                disabled={!on}
                onClick={() => {
                  setOn(false);
                  toast.action?.run();
                }}
              >
                {toast.action.label}
              </Button>
            )}
          </>
        )}
      </output>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
