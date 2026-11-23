import { Button, cx, Popover } from "@agenteschat/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";
import { COLOR_KEYS, TEXT_COLORS } from "./Toolbar";

/**
 * The sheets of a spreadsheet, as tabs along its bottom (ADR 0196): "+" adds one, a click opens one, a double click
 * renames it in place, dragging reorders, and its menu (right click, a long press, or the menu key) renames,
 * duplicates, colors or deletes it. The selection's sum, average and count sit at the right end.
 */

export interface SheetTab {
  id: string;
  name: string;
  /** The tab's color. */
  tab?: string | undefined;
}

export interface SheetTabsProps {
  sheets: readonly SheetTab[];
  current: string;
  editable: boolean;
  /** "Soma 1.234,00 · Média 411,33 · Contagem 3", or nothing. */
  status: ReactNode;
  onSelect(id: string): void;
  onAdd(): void;
  /** Renames; false keeps the field open (the name was refused). */
  onRename(id: string, name: string): boolean;
  onDuplicate(id: string): void;
  onDelete(id: string): void;
  onColor(id: string, color: string | null): void;
  onMove(id: string, to: number): void;
}

/** How far a tab moves before a press becomes a drag (CSS px). */
const DRAG_SLOP = 4;

export function SheetTabs(props: SheetTabsProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [coloring, setColoring] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const press = useRef<{ id: string; x: number; moved: boolean } | null>(null);

  const entries = (tab: SheetTab): MenuEntry[] =>
    props.editable
      ? [
          {
            kind: "item",
            id: "rename",
            label: t("live.sheet.tabs.rename"),
            icon: "edit",
            run: () => setRenaming(tab.id),
          },
          {
            kind: "item",
            id: "duplicate",
            label: t("live.sheet.tabs.duplicate"),
            icon: "copy",
            run: () => props.onDuplicate(tab.id),
          },
          {
            kind: "item",
            id: "color",
            label: t("live.sheet.tabs.color"),
            icon: "fillColor",
            run: () => setColoring(tab.id),
          },
          { kind: "separator" },
          {
            kind: "item",
            id: "delete",
            label: t("live.sheet.tabs.delete"),
            icon: "trash",
            danger: true,
            disabled: props.sheets.length <= 1,
            run: () => props.onDelete(tab.id),
          },
        ]
      : [];

  const openMenu = (tab: SheetTab, x: number, y: number) => {
    const list = entries(tab);
    if (list.length) openContextMenu(x, y, list);
  };

  /** Where a tab dropped at `x` lands in the order. */
  const slotAt = (x: number): number => {
    const tabs = [...(strip.current?.querySelectorAll<HTMLElement>("[data-sheet]") ?? [])];
    for (let i = 0; i < tabs.length; i++) {
      const r = (tabs[i] as HTMLElement).getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, tab: SheetTab) => {
    if (e.button !== 0 || !props.editable || renaming) return;
    press.current = { id: tab.id, x: e.clientX, moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.abs(e.clientX - p.x) < DRAG_SLOP) return;
    if (!p.moved) {
      p.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setDrag({ id: p.id, to: slotAt(e.clientX) });
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>, tab: SheetTab) => {
    const p = press.current;
    press.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (p?.moved && drag) {
      const from = props.sheets.findIndex((s) => s.id === drag.id);
      const to = drag.to > from ? drag.to - 1 : drag.to;
      setDrag(null);
      if (from >= 0 && to !== from) props.onMove(drag.id, to);
      return;
    }
    setDrag(null);
    if (tab.id !== props.current) props.onSelect(tab.id);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, tab: SheetTab, index: number) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(tab, r.left, r.top);
      return;
    }
    if (e.key === "F2" && props.editable) {
      e.preventDefault();
      setRenaming(tab.id);
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = props.sheets[(index + step + props.sheets.length) % props.sheets.length];
    if (!next) return;
    props.onSelect(next.id);
    strip.current?.querySelector<HTMLElement>(`[data-sheet="${next.id}"]`)?.focus();
  };

  // The open tab stays in view.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-sheet="${props.current}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.current]);

  return (
    <div className="sheet-tabs">
      {props.editable && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="plus"
          aria-label={t("live.sheet.tabs.add")}
          title={t("live.sheet.tabs.add")}
          onClick={props.onAdd}
        />
      )}
      <div ref={strip} className="sheet-tabs__strip" role="tablist" aria-label={t("live.sheet.tabs.label")}>
        {props.sheets.map((tab, index) =>
          renaming === tab.id ? (
            <RenameField
              key={tab.id}
              name={tab.name}
              label={t("live.sheet.tabs.renameLabel")}
              onDone={(name) => {
                if (name === null || name.trim() === tab.name) {
                  setRenaming(null);
                  return;
                }
                if (props.onRename(tab.id, name)) setRenaming(null);
              }}
            />
          ) : (
            <span key={tab.id} className="sheet-tabs__slot">
              {drag && drag.to === index && drag.id !== tab.id && (
                <span className="sheet-tabs__drop" aria-hidden="true" />
              )}
              <button
                type="button"
                role="tab"
                data-sheet={tab.id}
                aria-selected={tab.id === props.current}
                tabIndex={tab.id === props.current ? 0 : -1}
                className={cx(
                  "sheet-tabs__tab",
                  tab.id === props.current && "is-on",
                  drag?.id === tab.id && "is-dragging",
                )}
                style={tab.tab ? ({ "--tab": tab.tab } as React.CSSProperties) : undefined}
                onPointerDown={(e) => onDown(e, tab)}
                onPointerMove={onMove}
                onPointerUp={(e) => onUp(e, tab)}
                onPointerCancel={() => {
                  press.current = null;
                  setDrag(null);
                }}
                onClick={(e) => {
                  // A press with the keys (Enter, Space) opens the tab; the pointer's is handled on pointer up.
                  if (e.detail === 0 && tab.id !== props.current) props.onSelect(tab.id);
                }}
                onDoubleClick={() => props.editable && setRenaming(tab.id)}
                onKeyDown={(e) => onTabKey(e, tab, index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(tab, e.clientX, e.clientY);
                }}
              >
                {tab.tab && <span className="sheet-tabs__mark" aria-hidden="true" />}
                {tab.name}
              </button>
              {coloring === tab.id && (
                <Popover
                  label={t("live.sheet.tabs.color")}
                  side="top"
                  align="start"
                  open
                  onOpenChange={(open) => !open && setColoring(null)}
                  className="sheet-colors"
                  trigger={<span className="sheet-tabs__anchor" aria-hidden="true" />}
                >
                  <button
                    type="button"
                    className="sheet-colors__auto"
                    onClick={() => {
                      props.onColor(tab.id, null);
                      setColoring(null);
                    }}
                  >
                    <span className="sheet-colors__none" aria-hidden="true" />
                    {t("live.sheet.tabs.noColor")}
                  </button>
                  <div className="sheet-colors__grid">
                    {TEXT_COLORS.map((color, i) => (
                      <button
                        key={color}
                        type="button"
                        className={cx("sheet-colors__swatch", tab.tab === color && "is-on")}
                        style={{ background: color }}
                        aria-label={t(`live.sheet.colors.${COLOR_KEYS[i] ?? "slate"}`)}
                        title={t(`live.sheet.colors.${COLOR_KEYS[i] ?? "slate"}`)}
                        aria-pressed={tab.tab === color}
                        onClick={() => {
                          props.onColor(tab.id, color);
                          setColoring(null);
                        }}
                      />
                    ))}
                  </div>
                </Popover>
              )}
            </span>
          ),
        )}
        {drag && drag.to >= props.sheets.length && <span className="sheet-tabs__drop" aria-hidden="true" />}
      </div>
      <output className="sheet-tabs__status" aria-label={t("live.sheet.status.label")}>
        {props.status}
      </output>
    </div>
  );
}

/** A tab's name being edited in place: Enter or leaving keeps it, Esc goes back. */
function RenameField({ name, label, onDone }: { name: string; label: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
    // Refused: the field stays for another try.
    requestAnimationFrame(() => {
      done.current = false;
    });
  };
  return (
    <input
      ref={field}
      className="ac-input sheet-tabs__rename"
      aria-label={label}
      value={value}
      maxLength={31}
      size={Math.max(6, value.length + 1)}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}
