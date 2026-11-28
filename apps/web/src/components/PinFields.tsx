import { pinDigits, pinMismatch } from "@agenteschat/client/lib/surface-links";
import { Input } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * The PIN that confirms actions from the outside chat surface (ADR 0226): one hidden field to type it, or two to
 * choose it (`choosing`), digits only. `big`: the sign-in screen's large fields, on the pages a link opens.
 */
export function PinFields({
  pin,
  again,
  onPin,
  onAgain,
  choosing,
  disabled,
  big,
  autoFocus,
  onFocus,
  onBlur,
}: {
  pin: string;
  again: string;
  onPin: (pin: string) => void;
  onAgain: (again: string) => void;
  choosing: boolean;
  disabled?: boolean;
  big?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const { t } = useTranslation();
  const first = choosing ? t("surface.page.choosePin") : t("surface.page.pin");
  const field = (label: string, value: string, set: (v: string) => void, more: object) => (
    <div className={big ? "auth__field" : undefined}>
      <Input
        className={big ? "auth__big" : undefined}
        type="password"
        inputMode="numeric"
        maxLength={6}
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => set(pinDigits(e.target.value))}
        disabled={disabled}
        {...more}
      />
    </div>
  );
  return (
    <>
      {field(first, pin, onPin, {
        autoComplete: choosing ? "new-password" : "current-password",
        autoFocus,
        onFocus,
        onBlur,
      })}
      {choosing &&
        field(t("surface.page.repeatPin"), again, onAgain, {
          autoComplete: "new-password",
          "aria-invalid": pinMismatch(pin, again) || undefined,
        })}
    </>
  );
}
