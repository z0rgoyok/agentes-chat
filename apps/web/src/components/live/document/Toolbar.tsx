import {
  Button,
  Icon,
  type IconName,
  Input,
  isApple,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  useScrollSides,
} from "@agenteschat/ui";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRoving } from "../spreadsheet/Toolbar";
import { type FontChoices, FontPicker } from "../type/FontPicker";
import { TextStyleMenu, TypeGlyph, type TypeLook, type TypePatch } from "../type/TypeMenus";
import type { DocFormat, DocStyle } from "./commands";
import "../slides/slides.css";
import "../spreadsheet/sheet.css";

/**
 * The document's toolbar (ADR 0200), in the spreadsheet's look (`sheet-tools`): undo and redo | the block's style
 * ("Text ▾": text, headings 1 to 3, quote, code), the font and the text style menu "Aa" (ADR 0220 §8) | bold,
 * italic, underline, strikethrough | lists, quote, code |
 * link, picture, table. One row of 32 px buttons scrolling sideways when it doesn't fit, a single tab stop moved with
 * the arrow keys; every tip says the button's name and its keys. The picture and table buttons turn into menus of what
 * to do with the picture or the table the caret is on.
 */

export interface DocToolbarProps {
  format: DocFormat;
  canUndo: boolean;
  canRedo: boolean;
  /** Pictures on their way in. */
  uploading: number;
  /** The table the caret is in has a header row. */
  header: boolean;
  onUndo(): void;
  onRedo(): void;
  onStyle(style: DocStyle): void;
  onMark(mark: "bold" | "italic" | "underline" | "strike"): void;
  onList(kind: "bullet" | "ordered"): void;
  onLink(href: string | null): void;
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  onUpload(): void;
  onDrive(): void;
  onImageWidth(width: number | null): void;
  onRemoveImage(): void;
  onInsertTable(): void;
  onTable(action: TableAction): void;
  /** Focus goes back to the text after a menu. */
  onDone(): void;
  /** The font list's choices: the document's heading and text fonts, the file's own. */
  fonts: FontChoices;
  /** The font the list shows where the caret is: a role (`heading`, `body`) or a ref. */
  font: string;
  /** What the text style menu shows where the caret is. */
  look: TypeLook;
  /** The weights the font draws. */
  weights: readonly number[];
  onFont(ref: string): void;
  onType(patch: TypePatch): void;
  /** "Fontes do documento…". */
  onFileFonts(): void;
  /** "Trazer fonte do Drive…". */
  onBringFont(): void;
}

export type TableAction =
  | "rowAbove"
  | "rowBelow"
  | "columnLeft"
  | "columnRight"
  | "deleteRow"
  | "deleteColumn"
  | "header"
  | "deleteTable";

export const DOC_STYLES: readonly DocStyle[] = ["text", "h1", "h2", "h3", "quote", "code"];

/** Widths a picture takes, as a share of the page (null: its own size). */
const WIDTHS: readonly { key: "small" | "medium" | "large" | "full" | "natural"; width: number | null }[] = [
  { key: "small", width: 1 / 3 },
  { key: "medium", width: 1 / 2 },
  { key: "large", width: 3 / 4 },
  { key: "full", width: 1 },
  { key: "natural", width: null },
];

/** A shortcut as the platform writes it ("⌘⌥1", "Ctrl+Alt+1") and as `aria-keyshortcuts` names it. */
export function docKeys(key: string, mods: { shift?: boolean; alt?: boolean } = {}) {
  const apple = isApple();
  const shown = apple
    ? `⌘${mods.alt ? "⌥" : ""}${mods.shift ? "⇧" : ""}${key}`
    : `Ctrl+${mods.alt ? "Alt+" : ""}${mods.shift ? "Shift+" : ""}${key}`;
  const aria = `${apple ? "Meta" : "Control"}+${mods.alt ? "Alt+" : ""}${mods.shift ? "Shift+" : ""}${key}`;
  return { shown, aria };
}

/** The keys of a style in the menu (text and the headings have them). */
export function styleKeys(style: DocStyle): ReturnType<typeof docKeys> | null {
  if (style === "text") return docKeys("0", { alt: true });
  if (style === "h1" || style === "h2" || style === "h3") return docKeys(style.slice(1), { alt: true });
  return null;
}

const keep = (e: { preventDefault(): void }) => e.preventDefault();

export function DocToolbar(props: DocToolbarProps) {
  const { t } = useTranslation();
  const { format } = props;
  const bar = useRef<HTMLDivElement>(null);
  const sides = useScrollSides(bar);
  useRoving(bar);
  const apple = isApple();

  const tool = (
    icon: IconName,
    name: string,
    run: () => void,
    opts: { pressed?: boolean; disabled?: boolean; shortcut?: { shown: string; aria: string } } = {},
  ) => (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={name}
      title={opts.shortcut ? `${name} (${opts.shortcut.shown})` : name}
      aria-keyshortcuts={opts.shortcut?.aria}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onMouseDown={keep}
      onClick={() => {
        run();
        props.onDone();
      }}
    />
  );

  const menuButton = (icon: IconName, name: string, pressed?: boolean) => (
    <Button
      size="sm"
      variant="ghost"
      className="sheet-tools__menu"
      aria-label={name}
      title={name}
      aria-pressed={pressed}
      onMouseDown={keep}
    >
      <Icon name={icon} size={20} />
      <Icon name="chevronDown" size={14} className="sheet-tools__chev" />
    </Button>
  );

  const sep = <span className="sheet-tools__sep" aria-hidden="true" />;
  const styleName = (style: DocStyle) => t(`live.doc.style.${style}`);
  const check = (on: boolean) => (on ? "check" : undefined);
  const blank = (on: boolean) => (on ? undefined : <span className="sheet-tools__blank" />);

  return (
    <div
      ref={bar}
      className="sheet-tools lf-doc__tools"
      data-sides={sides}
      role="toolbar"
      aria-label={t("live.doc.toolbar")}
      aria-orientation="horizontal"
    >
      {tool("undo", t("live.doc.undo"), props.onUndo, { disabled: !props.canUndo, shortcut: docKeys("Z") })}
      {tool("redo", t("live.doc.redo"), props.onRedo, {
        disabled: !props.canRedo,
        shortcut: apple ? docKeys("Z", { shift: true }) : docKeys("Y"),
      })}
      {sep}
      <Menu
        label={t("live.doc.style.label")}
        onClosed={props.onDone}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            className="sheet-tools__menu lf-doc__style"
            aria-label={`${t("live.doc.style.label")}: ${styleName(format.style)}`}
            title={t("live.doc.style.label")}
            onMouseDown={keep}
          >
            <span className="lf-doc__style-name">{styleName(format.style)}</span>
            <Icon name="chevronDown" size={14} className="sheet-tools__chev" />
          </Button>
        }
      >
        {DOC_STYLES.map((style) => (
          <MenuItem
            key={style}
            icon={check(format.style === style)}
            leading={blank(format.style === style)}
            hint={styleKeys(style)?.shown}
            onSelect={() => props.onStyle(style)}
          >
            <span className="lf-doc__style-item" data-style={style}>
              {styleName(style)}
            </span>
          </MenuItem>
        ))}
      </Menu>
      <FontPicker
        choices={props.fonts}
        value={props.font}
        onChange={props.onFont}
        onFileFonts={props.onFileFonts}
        onBring={props.onBringFont}
        disabled={format.style === "code"}
      />
      <TextStyleMenu
        look={props.look}
        weights={props.weights}
        lines={false}
        onChange={props.onType}
        onClosed={props.onDone}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            className="sheet-tools__menu lf-doc__aa"
            aria-label={t("live.type.text")}
            title={t("live.type.text")}
            disabled={format.style === "code"}
            onMouseDown={keep}
          >
            <TypeGlyph />
            <Icon name="chevronDown" size={14} className="sheet-tools__chev" />
          </Button>
        }
      />
      {sep}
      {tool("bold", t("live.doc.bold"), () => props.onMark("bold"), {
        pressed: format.bold,
        shortcut: docKeys("B"),
      })}
      {tool("italic", t("live.doc.italic"), () => props.onMark("italic"), {
        pressed: format.italic,
        shortcut: docKeys("I"),
      })}
      {tool("underline", t("live.doc.underline"), () => props.onMark("underline"), {
        pressed: format.underline,
        shortcut: docKeys("U"),
      })}
      {tool("strike", t("live.doc.strike"), () => props.onMark("strike"), {
        pressed: format.strike,
        shortcut: docKeys("X", { shift: true }),
      })}
      {sep}
      {tool("bulletList", t("live.doc.bulletList"), () => props.onList("bullet"), {
        pressed: format.list === "bullet",
        shortcut: docKeys("8", { shift: true }),
      })}
      {tool("numberedList", t("live.doc.numberedList"), () => props.onList("ordered"), {
        pressed: format.list === "ordered",
        shortcut: docKeys("7", { shift: true }),
      })}
      {tool("quote", t("live.doc.quote"), () => props.onStyle("quote"), { pressed: format.style === "quote" })}
      {tool("codeBlock", t("live.doc.codeBlock"), () => props.onStyle("code"), { pressed: format.style === "code" })}
      {sep}
      <LinkButton
        current={format.link}
        open={props.linkOpen}
        onOpenChange={props.onLinkOpenChange}
        onLink={props.onLink}
        onDone={props.onDone}
        shortcut={docKeys("K")}
      />
      {format.image ? (
        <Menu
          label={t("live.doc.image.menu")}
          onClosed={props.onDone}
          trigger={menuButton("image", t("live.doc.image.menu"), true)}
        >
          {WIDTHS.map(({ key, width }) => (
            <MenuItem key={key} leading={blank(false)} onSelect={() => props.onImageWidth(width)}>
              {t(`live.doc.image.${key}`)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon="trash" danger onSelect={props.onRemoveImage}>
            {t("live.doc.image.remove")}
          </MenuItem>
        </Menu>
      ) : (
        <Menu
          label={t("live.doc.image.add")}
          onClosed={props.onDone}
          trigger={menuButton("image", t("live.doc.image.add"))}
        >
          <MenuItem icon="upload" onSelect={props.onUpload}>
            {t("live.doc.image.upload")}
          </MenuItem>
          <MenuItem icon="drive" onSelect={props.onDrive}>
            {t("live.doc.image.drive")}
          </MenuItem>
        </Menu>
      )}
      {format.table ? (
        <Menu
          label={t("live.doc.table.menu")}
          onClosed={props.onDone}
          trigger={menuButton("table", t("live.doc.table.menu"), true)}
        >
          <MenuItem icon="arrowUp" onSelect={() => props.onTable("rowAbove")}>
            {t("live.doc.table.rowAbove")}
          </MenuItem>
          <MenuItem icon="arrowDown" onSelect={() => props.onTable("rowBelow")}>
            {t("live.doc.table.rowBelow")}
          </MenuItem>
          <MenuItem icon="chevronLeft" onSelect={() => props.onTable("columnLeft")}>
            {t("live.doc.table.columnLeft")}
          </MenuItem>
          <MenuItem icon="chevronRight" onSelect={() => props.onTable("columnRight")}>
            {t("live.doc.table.columnRight")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={check(props.header)} leading={blank(props.header)} onSelect={() => props.onTable("header")}>
            {t("live.doc.table.header")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="dash" onSelect={() => props.onTable("deleteRow")}>
            {t("live.doc.table.deleteRow")}
          </MenuItem>
          <MenuItem icon="dash" onSelect={() => props.onTable("deleteColumn")}>
            {t("live.doc.table.deleteColumn")}
          </MenuItem>
          <MenuItem icon="trash" danger onSelect={() => props.onTable("deleteTable")}>
            {t("live.doc.table.deleteTable")}
          </MenuItem>
        </Menu>
      ) : (
        tool("table", t("live.doc.table.insert"), props.onInsertTable)
      )}
      {props.uploading > 0 && (
        <span className="lf-doc__busy" role="status">
          {t("live.doc.image.uploading", { count: props.uploading })}
        </span>
      )}
    </div>
  );
}

/** The link button: a small form under it with the address (the link already there, to change or take away). */
function LinkButton({
  current,
  open,
  onOpenChange,
  onLink,
  onDone,
  shortcut,
}: {
  current: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLink: (href: string | null) => void;
  onDone: () => void;
  shortcut: { shown: string; aria: string };
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
      label={t("live.doc.link.title")}
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
          aria-label={t("live.doc.link.title")}
          title={`${t("live.doc.link.title")} (${shortcut.shown})`}
          aria-keyshortcuts={shortcut.aria}
          aria-pressed={!!current}
          onMouseDown={keep}
        />
      }
    >
      <form className="sl-link" onSubmit={submit}>
        <Input
          value={href}
          placeholder={t("live.doc.link.placeholder")}
          aria-label={t("live.doc.link.address")}
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
              {t("live.doc.link.remove")}
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={!href.trim()}>
            {t("live.doc.link.apply")}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
