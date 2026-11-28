import type { FontRef } from "@agenteschat/live";
import type { RichAlign, RichList } from "@agenteschat/live/rich";
import type { ShapeKind, SlideLayout, SlideTheme, ThemeId } from "@agenteschat/live/slides";
import {
  Button,
  cx,
  Icon,
  type IconName,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  modKey,
  Popover,
  useScrollSides,
} from "@agenteschat/ui";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RichFormat, RichMarkKey } from "../rich";
import { type FontChoices, FontPicker } from "../type/FontPicker";
import {
  type EffectsLook,
  EffectsMenu,
  type EffectsPatch,
  TextStyleMenu,
  TypeGlyph,
  type TypeLook,
  type TypePatch,
} from "../type/TypeMenus";
import type { AlignHow } from "./actions";
import { LayoutPicker, Swatches, TableSizePicker, ThemePicker } from "./pickers";
import { useRoving } from "./roving";

/**
 * The presentation's toolbar (ADR 0196 §2): undo and redo; a new slide (with its layout), the slide's layout and the
 * deck's theme; text, pictures, shapes, charts and tables; the text group while a text is chosen (font, size, bold,
 * italic, underline, strikethrough, color, the text style menu "Aa", alignment, lists, indent, link); a shape's fill,
 * outline and effects, a line's arrow, a table's rows and columns; arranging; deleting (fonts and styles: ADR 0220 §8). One row of 32 px buttons in groups, scrolling sideways with faded
 * edges when it doesn't fit, a single tab stop moved with the arrows (`role="toolbar"`). A press on a button keeps
 * the caret where it was in the text being typed.
 */

/** The text being formatted: what is on where the caret is, or across the chosen boxes. */
export interface TextTools {
  format: RichFormat;
  /** The box's text size in slide units (the first chosen box's). */
  size: number;
  /** A caret is in the box (a link needs words chosen in it). */
  editing: boolean;
  /** The font the list shows: a role of the deck (`heading`, `body`) or a ref. */
  font: FontRef;
  /** What the text style menu shows. */
  look: TypeLook;
  /** The weights the font draws. */
  weights: readonly number[];
}

export interface ShapeTools {
  line: boolean;
  fill: string | null;
  stroke: string | null;
  arrow: boolean;
  /** A shape's shadow, gradient and border dash (null for a line). */
  effects: EffectsLook | null;
  /** It has a border, so its dash shows. */
  border: boolean;
}

export type TableOp = "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "deleteRow" | "deleteCol" | "header";

export interface SlideToolbarProps {
  theme: SlideTheme;
  /** The current slide's layout (null: no slide). */
  layout: SlideLayout | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Elements chosen on the slide. */
  selected: number;
  text: TextTools | null;
  shape: ShapeTools | null;
  table: { header: boolean } | null;
  chart: boolean;
  onUndo(): void;
  onRedo(): void;
  onNewSlide(layout?: SlideLayout): void;
  onLayout(layout: SlideLayout): void;
  onTheme(theme: ThemeId): void;
  onText(): void;
  onUpload(): void;
  onDrive(): void;
  onShape(kind: ShapeKind | "line"): void;
  onChart(): void;
  onEditChart(): void;
  onTable(rows: number, cols: number): void;
  onTableOp(op: TableOp): void;
  onMark(key: RichMarkKey): void;
  onColor(color: string | null): void;
  onAlign(align: RichAlign): void;
  onList(kind: RichList): void;
  onLevel(delta: 1 | -1): void;
  onSize(size: number): void;
  /** The font list's choices: the deck's heading and text fonts, the file's own. */
  fonts: FontChoices;
  onFont(ref: FontRef): void;
  onType(patch: TypePatch): void;
  /** "Fontes da apresentação…". */
  onFileFonts(): void;
  /** "Trazer fonte do Drive…". */
  onBringFont(): void;
  onEffects(patch: EffectsPatch): void;
  onLink(href: string | null): void;
  /** The link field is open (⌘K in a text opens it too). */
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  onFill(color: string | null): void;
  onStroke(color: string | null): void;
  onArrow(): void;
  onArrange(how: "front" | "back" | "forward" | "backward"): void;
  onAlignElements(how: AlignHow): void;
  onDelete(): void;
  /** A menu or a picker closed: the focus goes back where the person works (the text, the slide). */
  onDone(): void;
}

/** Text sizes offered, in slide units (a slide is 1920 wide: 40 is body text, 72 a title). */
export const TEXT_SIZES = [20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 88, 104, 120, 160, 200, 240] as const;

const SHAPES: readonly { kind: ShapeKind | "line"; icon: IconName }[] = [
  { kind: "rect", icon: "shape" },
  { kind: "ellipse", icon: "shape" },
  { kind: "triangle", icon: "shape" },
  { kind: "diamond", icon: "shape" },
  { kind: "arrow", icon: "arrowRight" },
  { kind: "line", icon: "dash" },
];

const ARRANGE = ["front", "forward", "backward", "back"] as const;
const ALIGN_ELEMENTS: readonly AlignHow[] = ["left", "center", "right", "top", "middle", "bottom"];

/** Keeps the caret in the text being typed when a button is pressed. */
const keep = (e: { preventDefault(): void }) => e.preventDefault();

export function SlideToolbar(props: SlideToolbarProps) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const sides = useScrollSides(bar);
  useRoving(bar);
  const mod = modKey();
  const keys = (key: string, shift = false) => `${mod}${shift ? "⇧" : ""}${key}`;
  const { text, shape, theme } = props;

  const tool = (
    icon: IconName,
    name: string,
    run: () => void,
    opts: { pressed?: boolean; disabled?: boolean; shortcut?: string } = {},
  ) => (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={name}
      title={opts.shortcut ? `${name} (${opts.shortcut})` : name}
      aria-keyshortcuts={opts.shortcut}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onMouseDown={keep}
      onClick={run}
    />
  );

  /** A button that opens a menu or a picker: its icon or words, then a small chevron. */
  const opener = (name: string, content: ReactNode, opts: { words?: boolean; disabled?: boolean } = {}) => (
    <Button
      size="sm"
      variant="ghost"
      className={cx("sl-tools__open", opts.words && "sl-tools__open--words")}
      aria-label={opts.words ? undefined : name}
      title={name}
      disabled={opts.disabled}
      onMouseDown={keep}
    >
      {content}
      <Icon name="chevronDown" size={14} className="sl-tools__chev" />
    </Button>
  );

  const sep = <span className="sl-tools__sep" aria-hidden="true" />;

  return (
    <div
      ref={bar}
      className="sl-tools"
      data-more={sides}
      role="toolbar"
      aria-label={t("live.slides.tools.label")}
      aria-orientation="horizontal"
    >
      {tool("undo", t("live.slides.tools.undo"), props.onUndo, { disabled: !props.canUndo, shortcut: keys("Z") })}
      {tool("redo", t("live.slides.tools.redo"), props.onRedo, {
        disabled: !props.canRedo,
        shortcut: keys("Z", true),
      })}
      {sep}
      <span className="sl-tools__pair">
        {tool("plus", t("live.slides.tools.newSlide"), () => props.onNewSlide())}
        <PickerPopover
          label={t("live.slides.tools.newSlideLayout")}
          trigger={opener(t("live.slides.tools.newSlideLayout"), null)}
          onDone={props.onDone}
        >
          {(close) => (
            <LayoutPicker
              theme={theme}
              onPick={(layout) => {
                close();
                props.onNewSlide(layout);
              }}
            />
          )}
        </PickerPopover>
      </span>
      <PickerPopover
        label={t("live.slides.layout.label")}
        trigger={opener(t("live.slides.layout.label"), t("live.slides.tools.layout"), {
          words: true,
          disabled: !props.layout,
        })}
        onDone={props.onDone}
      >
        {(close) => (
          <LayoutPicker
            theme={theme}
            current={props.layout ?? undefined}
            onPick={(layout) => {
              close();
              props.onLayout(layout);
            }}
          />
        )}
      </PickerPopover>
      <PickerPopover
        label={t("live.slides.theme.label")}
        trigger={opener(t("live.slides.theme.label"), t("live.slides.tools.theme"), { words: true })}
        onDone={props.onDone}
      >
        {(close) => (
          <ThemePicker
            current={theme.id}
            onPick={(id) => {
              close();
              props.onTheme(id);
            }}
          />
        )}
      </PickerPopover>
      {sep}
      {tool("textTool", t("live.slides.tools.text"), props.onText)}
      <Menu
        label={t("live.slides.tools.image")}
        onClosed={props.onDone}
        trigger={opener(t("live.slides.tools.image"), <Icon name="image" size={20} />)}
      >
        <MenuItem icon="upload" onSelect={props.onUpload}>
          {t("live.slides.image.upload")}
        </MenuItem>
        <MenuItem icon="drive" onSelect={props.onDrive}>
          {t("live.slides.image.drive")}
        </MenuItem>
      </Menu>
      <Menu
        label={t("live.slides.tools.shape")}
        onClosed={props.onDone}
        trigger={opener(t("live.slides.tools.shape"), <Icon name="shape" size={20} />)}
      >
        {SHAPES.map((s) => (
          <MenuItem key={s.kind} leading={<ShapeGlyph kind={s.kind} />} onSelect={() => props.onShape(s.kind)}>
            {t(`live.slides.shapes.${s.kind}`)}
          </MenuItem>
        ))}
      </Menu>
      {tool("chart", t("live.slides.tools.chart"), props.onChart)}
      <PickerPopover
        label={t("live.slides.tools.table")}
        trigger={opener(t("live.slides.tools.table"), <Icon name="table" size={20} />)}
        onDone={props.onDone}
      >
        {(close) => (
          <TableSizePicker
            onPick={(rows, cols) => {
              close();
              props.onTable(rows, cols);
            }}
          />
        )}
      </PickerPopover>
      {text && (
        <>
          {sep}
          <FontPicker
            choices={props.fonts}
            value={text.font}
            onChange={props.onFont}
            onFileFonts={props.onFileFonts}
            onBring={props.onBringFont}
          />
          <Menu
            label={t("live.slides.tools.size")}
            onClosed={props.onDone}
            trigger={opener(
              t("live.slides.tools.size"),
              <span className="sl-tools__size tabular">{Math.round(text.size)}</span>,
            )}
          >
            {TEXT_SIZES.map((size) => (
              <MenuItem
                key={size}
                icon={Math.round(text.size) === size ? "check" : undefined}
                leading={Math.round(text.size) === size ? undefined : <span className="sl-tools__blank" />}
                onSelect={() => props.onSize(size)}
              >
                <span className="tabular">{size}</span>
              </MenuItem>
            ))}
          </Menu>
          {tool("bold", t("live.slides.tools.bold"), () => props.onMark("bold"), {
            pressed: text.format.bold,
            shortcut: keys("B"),
          })}
          {tool("italic", t("live.slides.tools.italic"), () => props.onMark("italic"), {
            pressed: text.format.italic,
            shortcut: keys("I"),
          })}
          {tool("underline", t("live.slides.tools.underline"), () => props.onMark("underline"), {
            pressed: text.format.underline,
            shortcut: keys("U"),
          })}
          {tool("strike", t("live.slides.tools.strike"), () => props.onMark("strike"), {
            pressed: text.format.strike,
            shortcut: keys("X", true),
          })}
          <PickerPopover
            label={t("live.slides.tools.textColor")}
            trigger={opener(
              t("live.slides.tools.textColor"),
              <ColorGlyph icon="textColor" color={text.format.color} />,
            )}
            onDone={props.onDone}
          >
            {(close) => (
              <Swatches
                theme={theme}
                value={text.format.color}
                none={t("live.slides.colors.automatic")}
                onPick={(color) => {
                  close();
                  props.onColor(color);
                }}
              />
            )}
          </PickerPopover>
          <TextStyleMenu
            look={text.look}
            weights={text.weights}
            onChange={props.onType}
            onClosed={props.onDone}
            trigger={opener(t("live.type.text"), <TypeGlyph />)}
          />
          {tool("alignLeft", t("live.slides.tools.alignLeft"), () => props.onAlign("left"), {
            pressed: (text.format.align ?? "left") === "left",
          })}
          {tool("alignCenter", t("live.slides.tools.alignCenter"), () => props.onAlign("center"), {
            pressed: text.format.align === "center",
          })}
          {tool("alignRight", t("live.slides.tools.alignRight"), () => props.onAlign("right"), {
            pressed: text.format.align === "right",
          })}
          {tool("bulletList", t("live.slides.tools.bullets"), () => props.onList("bullet"), {
            pressed: text.format.list === "bullet",
          })}
          {tool("numberedList", t("live.slides.tools.numbers"), () => props.onList("ordered"), {
            pressed: text.format.list === "ordered",
          })}
          {tool("outdent", t("live.slides.tools.outdent"), () => props.onLevel(-1), {
            disabled: text.format.level <= 0,
            shortcut: "⇧Tab",
          })}
          {tool("indent", t("live.slides.tools.indent"), () => props.onLevel(1), { shortcut: "Tab" })}
          <LinkButton
            current={text.format.link}
            disabled={!text.editing}
            open={props.linkOpen && text.editing}
            onOpenChange={props.onLinkOpenChange}
            onLink={props.onLink}
            onDone={props.onDone}
            shortcut={keys("K")}
          />
        </>
      )}
      {shape && (
        <>
          {sep}
          {!shape.line && (
            <PickerPopover
              label={t("live.slides.tools.fill")}
              trigger={opener(t("live.slides.tools.fill"), <ColorGlyph icon="fillColor" color={shape.fill} />)}
              onDone={props.onDone}
            >
              {(close) => (
                <Swatches
                  theme={theme}
                  value={shape.fill}
                  none={t("live.slides.colors.noFill")}
                  onPick={(color) => {
                    close();
                    props.onFill(color);
                  }}
                />
              )}
            </PickerPopover>
          )}
          <PickerPopover
            label={shape.line ? t("live.slides.tools.lineColor") : t("live.slides.tools.stroke")}
            trigger={opener(
              shape.line ? t("live.slides.tools.lineColor") : t("live.slides.tools.stroke"),
              <ColorGlyph icon="borders" color={shape.stroke} />,
            )}
            onDone={props.onDone}
          >
            {(close) => (
              <Swatches
                theme={theme}
                value={shape.stroke}
                none={shape.line ? t("live.slides.colors.automatic") : t("live.slides.colors.noStroke")}
                onPick={(color) => {
                  close();
                  props.onStroke(color);
                }}
              />
            )}
          </PickerPopover>
          {shape.effects && (
            <EffectsMenu
              look={shape.effects}
              scale="slides"
              border={shape.border}
              onChange={props.onEffects}
              onClosed={props.onDone}
              trigger={opener(t("live.type.effects"), t("live.type.effects"), { words: true })}
            />
          )}
          {shape.line && tool("arrowRight", t("live.slides.tools.arrowEnd"), props.onArrow, { pressed: shape.arrow })}
        </>
      )}
      {props.table && (
        <>
          {sep}
          <Menu
            label={t("live.slides.table.edit")}
            onClosed={props.onDone}
            trigger={opener(t("live.slides.table.edit"), <Icon name="table" size={20} />)}
          >
            <MenuItem onSelect={() => props.onTableOp("rowAbove")}>{t("live.slides.table.rowAbove")}</MenuItem>
            <MenuItem onSelect={() => props.onTableOp("rowBelow")}>{t("live.slides.table.rowBelow")}</MenuItem>
            <MenuItem onSelect={() => props.onTableOp("colLeft")}>{t("live.slides.table.colLeft")}</MenuItem>
            <MenuItem onSelect={() => props.onTableOp("colRight")}>{t("live.slides.table.colRight")}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => props.onTableOp("deleteRow")}>{t("live.slides.table.deleteRow")}</MenuItem>
            <MenuItem onSelect={() => props.onTableOp("deleteCol")}>{t("live.slides.table.deleteCol")}</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={props.table.header ? "check" : undefined}
              leading={props.table.header ? undefined : <span className="sl-tools__blank" />}
              onSelect={() => props.onTableOp("header")}
            >
              {t("live.slides.table.header")}
            </MenuItem>
          </Menu>
        </>
      )}
      {props.chart && (
        <>
          {sep}
          <Button size="sm" variant="ghost" icon="chart" onMouseDown={keep} onClick={props.onEditChart}>
            {t("live.slides.chart.editData")}
          </Button>
        </>
      )}
      {sep}
      <Menu
        label={t("live.slides.tools.arrange")}
        onClosed={props.onDone}
        trigger={opener(t("live.slides.tools.arrange"), <Icon name="layers" size={20} />, {
          disabled: props.selected === 0,
        })}
      >
        {ARRANGE.map((how) => (
          <MenuItem
            key={how}
            icon={how === "front" ? "bringFront" : how === "back" ? "sendBack" : undefined}
            leading={how === "front" || how === "back" ? undefined : <span className="sl-tools__blank" />}
            onSelect={() => props.onArrange(how)}
          >
            {t(`live.slides.arrange.${how}`)}
          </MenuItem>
        ))}
        <MenuSeparator />
        {ALIGN_ELEMENTS.map((how) => (
          <MenuItem
            key={how}
            leading={<span className="sl-tools__blank" />}
            onSelect={() => props.onAlignElements(how)}
          >
            {t(`live.slides.align.${how}`)}
          </MenuItem>
        ))}
      </Menu>
      {tool("trash", t("live.slides.tools.delete"), props.onDelete, { disabled: props.selected === 0, shortcut: "⌫" })}
    </div>
  );
}

/** A picker in a popover that closes when a choice is made, giving the focus back. */
function PickerPopover({
  label,
  trigger,
  onDone,
  children,
}: {
  label: string;
  trigger: ReactNode;
  onDone: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      label={label}
      side="bottom"
      className="sl-pop"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onDone();
      }}
      trigger={trigger}
    >
      {open && children(() => setOpen(false))}
    </Popover>
  );
}

/** A color button's glyph: its icon with the current color as a bar under it. */
function ColorGlyph({ icon, color }: { icon: IconName; color: string | null }) {
  return (
    <span className="sl-tools__color">
      <Icon name={icon} size={20} />
      <span className="sl-tools__colorbar" style={{ background: color ?? "currentColor" }} aria-hidden="true" />
    </span>
  );
}

/** A shape's little outline, for the shape menu. */
function ShapeGlyph({ kind }: { kind: ShapeKind | "line" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" as const };
  return (
    <svg className="ac-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {kind === "rect" && <rect x="3.5" y="5" width="13" height="10" rx="1.5" {...common} />}
      {kind === "ellipse" && <ellipse cx="10" cy="10" rx="6.5" ry="5" {...common} />}
      {kind === "triangle" && <path d="M10 4.5 16.5 15.5h-13z" {...common} />}
      {kind === "diamond" && <path d="M10 3.5 16.5 10 10 16.5 3.5 10z" {...common} />}
      {kind === "arrow" && <path d="M3.5 8h7V5l6 5-6 5v-3h-7z" {...common} />}
      {kind === "line" && <path d="M4 16 16 4" {...common} strokeLinecap="round" />}
    </svg>
  );
}

/** The link of the words chosen in the text: an address field, Apply and Remove. */
function LinkButton({
  current,
  disabled,
  open,
  onOpenChange,
  onLink,
  onDone,
  shortcut,
}: {
  current: string | null;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLink: (href: string | null) => void;
  onDone: () => void;
  shortcut: string;
}) {
  const { t } = useTranslation();
  const [href, setHref] = useState("");
  const [was, setWas] = useState(false);
  // The field starts with the link already there, each time it opens.
  if (open !== was) {
    setWas(open);
    if (open) setHref(current ?? "");
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onOpenChange(false);
    onLink(href.trim() || null);
  };
  return (
    <Popover
      label={t("live.slides.tools.link")}
      side="bottom"
      className="sl-pop"
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onDone();
      }}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="link"
          aria-label={t("live.slides.tools.link")}
          title={`${t("live.slides.tools.link")} (${shortcut})`}
          aria-keyshortcuts={shortcut}
          aria-pressed={!!current}
          disabled={disabled}
          onMouseDown={keep}
        />
      }
    >
      <form className="sl-link" onSubmit={submit}>
        <Input
          value={href}
          placeholder={t("live.slides.link.placeholder")}
          aria-label={t("live.slides.link.address")}
          onChange={(e) => setHref(e.target.value)}
        />
        <div className="sl-link__acts">
          {current && (
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onLink(null);
              }}
            >
              {t("live.slides.link.remove")}
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={!href.trim()}>
            {t("live.slides.link.apply")}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
