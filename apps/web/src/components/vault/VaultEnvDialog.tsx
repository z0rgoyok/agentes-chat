import type { VaultAccess, VaultOverview, VaultScope } from "@agenteschat/client";
import {
  ENV_MAX_BYTES,
  ENV_MAX_KEYS,
  type EnvFile,
  type EnvReviewRow,
  envImportInput,
  envReview,
  parseEnvFile,
  savedKeyNames,
} from "@agenteschat/client/lib/vault";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Checkbox,
  codeAndBold,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Locked,
  Segmented,
  SettingNote,
  Textarea,
} from "@agenteschat/ui";
import { type DragEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useVaultKeysImport } from "./data";
import { defaultAccess } from "./lib";
import { AccessBlock } from "./VaultAccess";
import "./vault.css";

/*
 * "Import .env" (ADR 0144 §11): a .env file (or a JSON object of names and values) picked, dropped or pasted, read
 * here in the browser, reviewed key by key (new, already saved, not importable), then saved in one request as
 * Personal or Team keys with one access. The file's text and its values live in this dialog only: they go once, in
 * the save, and with the dialog when it closes.
 */

const hasFiles = (dt: DataTransfer | null) => Boolean(dt && Array.from(dt.types).includes("Files"));

/** One key of the file: its name and what happens to it, then its value behind dots until asked. */
function EnvRow({
  row,
  replace,
  onReplace,
}: {
  row: EnvReviewRow;
  replace: boolean;
  onReplace: (replace: boolean) => void;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <li className="vlt-env__row" data-state={row.state}>
      <span className="vlt-env__head">
        <code className="vlt-code vlt-env__name">{row.name}</code>
        {row.problem && <span className="vlt-env__problem">{codeAndBold(t(`vault.env.problem.${row.problem}`))}</span>}
        {row.state === "new" && <span className="vlt-env__state">{t("vault.env.new")}</span>}
        {row.state === "exists" && (
          <span className="vlt-env__choice">
            <span className="vlt-env__state">{t("vault.env.exists")}</span>
            <label htmlFor={id} className="vlt-env__replace">
              <Checkbox id={id} checked={replace} onCheckedChange={onReplace} />
              {t("vault.env.replace")}
            </label>
          </span>
        )}
      </span>
      {row.state !== "problem" && (
        <span className="vlt-env__value">
          {shown ? (
            <span className="vlt-mono vlt-env__text">{row.value}</span>
          ) : (
            <>
              <span className="vlt-secret__dots" aria-hidden="true">
                ••••••••••
              </span>
              <span className="ac-visually-hidden">{t("vault.item.hidden")}</span>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={shown ? "eyeOff" : "eye"}
            aria-label={t(shown ? "vault.env.hide" : "vault.env.show", { name: row.name })}
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
          />
        </span>
      )}
    </li>
  );
}

export function VaultEnvDialog({
  overview,
  scope: startScope,
  onClose,
  onSaved,
}: {
  overview: VaultOverview;
  /** The tab it was opened from. */
  scope: VaultScope;
  onClose: () => void;
  onSaved: (scope: VaultScope) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const importer = useVaultKeysImport(org.id);
  const input = useRef<HTMLInputElement>(null);
  const canManageTeam = overview.canManageTeam;
  const [over, setOver] = useState(false);
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<EnvFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<VaultScope>(canManageTeam ? startScope : "personal");
  const [access, setAccess] = useState<VaultAccess>(() => defaultAccess(canManageTeam ? startScope : "personal"));
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());

  const review = (text: string) => {
    if (text.length > ENV_MAX_BYTES) return setError(t("vault.env.tooLarge"));
    const parsed = parseEnvFile(text);
    if (parsed.entries.length === 0) return setError(t("vault.env.none"));
    if (parsed.entries.length > ENV_MAX_KEYS) return setError(t("vault.env.tooMany", { max: ENV_MAX_KEYS }));
    setError(null);
    setFile(parsed);
    // Reviewed: the pasted text has nothing left to do here.
    setPasted("");
  };
  const read = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > ENV_MAX_BYTES) return setError(t("vault.env.tooLarge"));
    try {
      review(await picked.text());
    } catch {
      setError(t("vault.import.unreadable"));
    }
  };
  const pickScope = (next: VaultScope) => {
    setScope(next);
    // Each scope's own starting access, and its own saved names: a choice made for the other one doesn't carry.
    setAccess(defaultAccess(next));
    setReplace(new Set());
  };
  const stop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const rows = file ? envReview(file, savedKeyNames(overview.items, scope)) : [];
  const toSave = envImportInput(rows, replace, scope, access);
  const total = toSave.keys.length;
  const save = async () => {
    const result = await importer.run(toSave);
    if (!result) return;
    toast.show(t("vault.new.saved"));
    onSaved(scope);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.env.title")}
      description={file ? undefined : t("vault.env.text")}
      closeLabel={t("common.close")}
      width={560}
    >
      <Locked when={importer.busy}>
        <DialogBody className="vlt-import">
          {!file && (
            <>
              <div className="vlt-drop" data-over={over || undefined}>
                <button
                  type="button"
                  className="vlt-drop__area"
                  onClick={() => input.current?.click()}
                  onDragEnter={(e) => stop(e) && setOver(true)}
                  onDragOver={(e) => {
                    if (stop(e)) e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                    if (!stop(e)) return;
                    setOver(false);
                    void read(e.dataTransfer.files[0]);
                  }}
                >
                  <span className="vlt-drop__icon">
                    <Icon name="upload" size={20} />
                  </span>
                  <b>{t("vault.import.dropTitle")}</b>
                  <span>{t("vault.import.dropText")}</span>
                </button>
                {/* No `accept`: a .env file has no type a browser knows, and its name is often just `.env`. */}
                <input
                  ref={input}
                  type="file"
                  hidden
                  aria-label={t("vault.import.choose")}
                  onChange={(e) => {
                    void read(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              <Field label={t("vault.env.paste")}>
                <Textarea
                  className="vlt-mono"
                  rows={4}
                  value={pasted}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={"ACME_API_KEY=\nACME_DB_URL="}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setError(null);
                  }}
                  data-1p-ignore
                />
              </Field>
              {error && (
                <p className="ac-field__error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
          {file && (
            <>
              {file.duplicates.length > 0 && (
                <SettingNote icon="info">
                  {t("vault.env.duplicates", { names: file.duplicates.join(", ") })}
                </SettingNote>
              )}
              <ul className="vlt-env" aria-label={t("vault.kindPlural.keyTitle")}>
                {rows.map((row) => (
                  <EnvRow
                    key={row.name}
                    row={row}
                    replace={replace.has(row.name)}
                    onReplace={(on) =>
                      setReplace((chosen) => {
                        const next = new Set(chosen);
                        if (on) next.add(row.name);
                        else next.delete(row.name);
                        return next;
                      })
                    }
                  />
                ))}
              </ul>
              {/* Where they go: a choice for who manages the Vault, a plain line for everyone else (always theirs). */}
              {canManageTeam ? (
                <div className="ac-field">
                  <span className="ac-field__label">{t("vault.import.as")}</span>
                  <Segmented<VaultScope>
                    label={t("vault.import.as")}
                    value={scope}
                    onValueChange={pickScope}
                    options={[
                      { value: "personal", label: t("vault.scope.personal") },
                      { value: "team", label: t(modeKey(org, "vault.scope.team")) },
                    ]}
                  />
                </div>
              ) : (
                <SettingNote icon="lock">{t("vault.import.asPersonal")}</SettingNote>
              )}
              <AccessBlock
                scope={scope}
                access={access}
                editable
                onChange={(next) => {
                  setAccess(next);
                  return true;
                }}
              />
            </>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter
        // As a note, so a narrow dialog puts it over Cancel and Import instead of splitting those two.
        note={
          file ? (
            <Button
              variant="ghost"
              disabled={importer.busy}
              onClick={() => {
                setFile(null);
                setReplace(new Set());
              }}
            >
              {t("vault.import.another")}
            </Button>
          ) : undefined
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {file ? (
          <Button
            variant="primary"
            disabled={total === 0 || importer.busy}
            loading={importer.busy}
            onClick={() => void save()}
          >
            {t("vault.import.confirm", { count: total })}
          </Button>
        ) : (
          <Button variant="primary" disabled={pasted.trim() === ""} onClick={() => review(pasted)}>
            {t("vault.env.review")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
