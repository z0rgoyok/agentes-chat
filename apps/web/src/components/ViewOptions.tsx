import { Button, Icon, type IconName, Popover } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import "./view-options.css";

export type MiniLayoutKind = "board" | "list" | "grid";

/** A layout card's picture: a tiny board, list or grid of cards in pixels. */
export function MiniLayout({ layout }: { layout: MiniLayoutKind }) {
  const parts: ReactNode[] = [];
  if (layout === "board") {
    for (let k = 0; k < 3; k++) {
      const x = 2 + k * 15;
      parts.push(<rect key={`well${k}`} className="view-mini__well" x={x} y={2} width={13} height={26} />);
      for (let j = 0; j < 3 - k; j++) {
        parts.push(
          <rect key={`card${k}${j}`} className="view-mini__card" x={x + 1} y={5 + j * 7} width={11} height={6} />,
          <rect
            key={`ink${k}${j}`}
            className="view-mini__ink"
            x={x + 3}
            y={7 + j * 7}
            width={5 + ((j + k) % 3)}
            height={1}
          />,
        );
      }
    }
  } else if (layout === "grid") {
    // Two rows of three cards, each a preview over its name.
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 3; k++) {
        const x = 2 + k * 15;
        const y = 2 + r * 14;
        parts.push(
          <rect key={`card${r}${k}`} className="view-mini__card" x={x} y={y} width={13} height={12} />,
          <rect key={`well${r}${k}`} className="view-mini__well" x={x + 1} y={y + 1} width={11} height={7} />,
          <rect
            key={`ink${r}${k}`}
            className="view-mini__ink"
            x={x + 2}
            y={y + 9.5}
            width={5 + ((r + k) % 3)}
            height={1}
          />,
        );
      }
    }
  } else {
    for (let j = 0; j < 5; j++) {
      parts.push(
        <rect
          key={`row${j}`}
          className={j === 0 ? "view-mini__well" : "view-mini__card"}
          x={2}
          y={3 + j * 5}
          width={44}
          height={4}
        />,
        <rect
          key={`ink${j}`}
          className="view-mini__ink"
          x={5}
          y={4.5 + j * 5}
          width={j === 0 ? 10 : 18 + (j % 3) * 5}
          height={1}
        />,
      );
    }
  }
  return (
    <svg
      className="view-mini"
      viewBox="0 0 48 30"
      width={96}
      height={60}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {parts}
    </svg>
  );
}

/**
 * "Exibição" on a list's toolbar (Tasks, the Drive): the button reads the layout and what groups it ("Quadro · Etapa",
 * "Grade · Data") and opens the page's choices, the layout cards first.
 */
export function ViewOptions({
  label,
  buttonLabel,
  icon,
  layout,
  detail,
  iconOnly = false,
  children,
}: {
  /** The popover's accessible name ("Exibição"). */
  label: string;
  /** The button's accessible name ("Exibição: Quadro · Etapa"). */
  buttonLabel: string;
  icon: IconName;
  /** The layout's name, then what groups it, quieter. */
  layout: string;
  detail: string;
  /** Its icon alone (a phone's toolbar). */
  iconOnly?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={label}
      side="bottom"
      align="end"
      className="view-options"
      trigger={
        iconOnly ? (
          <Button size="sm" iconOnly icon={icon} aria-label={buttonLabel} title={buttonLabel} />
        ) : (
          <Button size="sm" className="view-options__trigger" aria-label={buttonLabel}>
            <Icon name={icon} size={16} />
            <span>
              {layout}
              <span className="view-options__sub"> · {detail}</span>
            </span>
            <Icon name="chevronDown" size={14} className="view-options__chev" />
          </Button>
        )
      }
    >
      {children}
    </Popover>
  );
}

/** The layouts as two cards with their pictures, the one in use pressed. */
export function LayoutCards<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string; picture: MiniLayoutKind }[];
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: two toggles side by side, not a form's fieldset
    <div className="view-layouts" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="view-layout"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          <MiniLayout layout={o.picture} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
