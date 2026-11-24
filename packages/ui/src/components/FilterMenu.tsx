import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons/Icon";
import { Button } from "./Button";
import { Menu } from "./Menu";

/** A filter in use, as its chip: "Responsável: Ada", "Tipo: Planilhas". */
export interface FilterMenuChip {
  key: string;
  icon: IconName;
  text: string;
  /** The ×'s accessible name ("Limpar Ada"). */
  clearLabel: string;
  clear: () => void;
}

/**
 * "Filtro" and the filters in use: one menu holds every filter (the page's checkbox items under their headings), and
 * each filter in use is a chip that opens the same menu, with a × to take it off. With a chip there the button keeps
 * only its icon.
 */
export function FilterMenu({
  label,
  buttonText,
  chips,
  children,
}: {
  /** The menu's accessible name. */
  label: string;
  /** The button's word ("Filtro"), its name when it shows only the icon. */
  buttonText: string;
  chips: FilterMenuChip[];
  /** The menu's items. */
  children: ReactNode;
}) {
  return (
    <span className="ac-filterbar">
      {chips.map((c) => (
        <span key={c.key} className="ac-filter ac-filter--active">
          <Menu
            label={label}
            trigger={
              <button type="button" className="ac-filter__trigger">
                <Icon name={c.icon} size={14} />
                <span className="ac-filter__text">{c.text}</span>
              </button>
            }
          >
            {children}
          </Menu>
          <button type="button" className="ac-filter__clear" aria-label={c.clearLabel} onClick={c.clear}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      <Menu
        label={label}
        trigger={
          <Button size="sm" icon="filter" iconOnly={chips.length > 0} aria-label={buttonText}>
            {buttonText}
          </Button>
        }
      >
        {children}
      </Menu>
    </span>
  );
}
