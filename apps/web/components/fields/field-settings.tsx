import {
  BOOLEAN_APPEARANCES,
  MAX_MASK_LENGTH,
  MULTI_SELECT_APPEARANCES,
  OPTION_COLORS,
  RATING_ICONS,
  SINGLE_SELECT_APPEARANCES,
} from "@anygriddb/core";
import { Button, Checkbox, Input, Label, Select, Tooltip } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  codeAppearance,
  DRAFT_SPOT_CONTROLS,
  type DraftSpot,
  type FieldDraft,
  type FieldOption,
  moveOption,
  typedBound,
} from "./field-draft";
import { OPTION_COLOR_NAMES, OptionColorButton } from "./option-color";

/** A section of the field dialog: it reads the draft and changes it. */
export type SettingsProps = {
  draft: FieldDraft;
  set: (change: Partial<FieldDraft>) => void;
  /** The parts still missing, once the dialog was sent (`draftProblems`). */
  problems?: ReadonlySet<DraftSpot>;
};

/** What a part of the dialog still needs, under its control. */
export function Missing({ control, text }: { control: string; text: string }) {
  return (
    <p id={`${control}-problem`} className="text-xs text-danger">
      {text}
    </p>
  );
}

/** What marks a control whose part is missing, and points to why. */
export function missingProps(control: string, missing: boolean) {
  return missing
    ? {
        "aria-invalid": true as const,
        "aria-describedby": `${control}-problem`,
      }
    : {};
}

/** A place up or down, for an option that has one. */
const MOVE =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-disabled:opacity-40 aria-disabled:hover:bg-transparent";

/**
 * The options of a list: each named once, coloured, put in its place, and
 * deleted. Their order is the one a cell offers them in, and a kanban its
 * stacks.
 */
function OptionsEditor({
  options,
  onChange,
  missing,
}: {
  options: FieldOption[];
  onChange: (options: FieldOption[]) => void;
  /** The list may not be empty, and is. */
  missing: boolean;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t`Options`}</Label>
      <ul className="flex flex-col gap-1">
        {options.map((option, index) => (
          <li
            key={option.id ?? String(index)}
            className="flex items-center gap-1.5"
          >
            {/* The first and the last keep their buttons, so that the
                focus stays on the one just pressed: they say they do
                nothing more. */}
            <Tooltip content={t`Move up`}>
              <button
                type="button"
                aria-label={t`Move ${{ option: option.name }} up`}
                aria-disabled={index === 0}
                className={MOVE}
                onClick={() => onChange(moveOption(options, index, -1))}
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip content={t`Move down`}>
              <button
                type="button"
                aria-label={t`Move ${{ option: option.name }} down`}
                aria-disabled={index === options.length - 1}
                className={MOVE}
                onClick={() => onChange(moveOption(options, index, 1))}
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <OptionColorButton
              label={t`Colour of ${{ option: option.name }}`}
              value={option.color}
              onChange={(color) =>
                onChange(
                  options.map((item, at) =>
                    at === index ? { ...item, color } : item,
                  ),
                )
              }
            />
            <Input
              className="h-8"
              aria-label={t`Option name`}
              value={option.name}
              onChange={(event) =>
                onChange(
                  options.map((item, at) =>
                    at === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={t`Delete`}
              onClick={() => onChange(options.filter((_, at) => at !== index))}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.trim();
          if (!name || options.some((option) => option.name === name)) return;
          onChange([
            ...options,
            {
              name,
              color:
                OPTION_COLORS[options.length % OPTION_COLORS.length] ?? "gray",
              id: crypto.randomUUID(),
            },
          ]);
          setDraft("");
        }}
      >
        <Input
          id={DRAFT_SPOT_CONTROLS.options}
          className="h-8"
          placeholder={t`New option`}
          aria-label={t`New option`}
          {...missingProps(DRAFT_SPOT_CONTROLS.options, missing)}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          aria-label={t`Add the option`}
        >
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </form>
      {missing ? (
        <Missing
          control={DRAFT_SPOT_CONTROLS.options}
          text={t`Add at least one option.`}
        />
      ) : null}
    </div>
  );
}

/** A list of options, and how a cell draws the ones it holds. */
export function OptionsSettings({ draft, set, problems }: SettingsProps) {
  const { t } = useLingui();
  return (
    <>
      <OptionsEditor
        options={draft.options}
        onChange={(options) => set({ options })}
        missing={problems?.has("options") === true}
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor="field-appearance">{t`Display`}</Label>
        <Select
          id="field-appearance"
          value={draft.appearance || "badge"}
          onChange={(event) =>
            set({
              appearance:
                event.target.value === "badge" ? "" : event.target.value,
            })
          }
        >
          <option value="badge">{t`Coloured badges`}</option>
          <option value="text">{t`Plain text`}</option>
          {draft.fieldType === "single_select"
            ? SINGLE_SELECT_APPEARANCES.filter(
                (value) => value === "radio",
              ).map((value) => (
                <option key={value} value={value}>
                  {t`Radio buttons`}
                </option>
              ))
            : null}
          {draft.fieldType === "multi_select"
            ? MULTI_SELECT_APPEARANCES.filter(
                (value) => value === "checklist",
              ).map((value) => (
                <option key={value} value={value}>
                  {t`Checklist`}
                </option>
              ))
            : null}
        </Select>
      </div>
    </>
  );
}

/** A short text drawn as itself, or as a code a scanner reads. */
export function CodeSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  const drawnAs = codeAppearance(draft);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="field-appearance">{t`Display`}</Label>
      <Select
        id="field-appearance"
        value={drawnAs ?? "text"}
        onChange={(event) =>
          set({
            appearance: event.target.value === "text" ? "" : event.target.value,
          })
        }
      >
        <option value="text">{t`Text`}</option>
        <option value="qr">{t`QR code`}</option>
        <option value="barcode">{t`Barcode`}</option>
      </Select>
      {drawnAs ? (
        <p className="text-xs text-muted-foreground">
          {t`An expanded row draws this field's text as a code, for a scanner to read.`}
        </p>
      ) : null}
    </div>
  );
}

/** A checkbox, a switch, or the words yes and no. */
export function CheckboxSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="field-appearance">{t`Display`}</Label>
      <Select
        id="field-appearance"
        value={draft.appearance || "check"}
        onChange={(event) =>
          set({
            appearance:
              event.target.value === "check" ? "" : event.target.value,
          })
        }
      >
        {BOOLEAN_APPEARANCES.map((value) => (
          <option key={value} value={value}>
            {value === "check"
              ? t`Checkbox`
              : value === "switch"
                ? t`Switch`
                : t`Yes / No`}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** How a number is written, and whether it may go under zero. */
export function NumberSettings({ draft, set, problems }: SettingsProps) {
  const { t } = useLingui();
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="number-style">{t`Format`}</Label>
          <Select
            id="number-style"
            value={draft.numberStyle}
            onChange={(event) => set({ numberStyle: event.target.value })}
          >
            <option value="decimal">{t`Decimal`}</option>
            <option value="percent">{t`Percent`}</option>
            <option value="currency">{t`Currency`}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="number-precision">{t`Decimals`}</Label>
          <Select
            id="number-precision"
            value={draft.precision}
            onChange={(event) => set({ precision: event.target.value })}
          >
            <option value="">{t`Auto`}</option>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        {draft.numberStyle === "currency" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="number-currency">{t`Currency`}</Label>
            <Input
              id="number-currency"
              maxLength={3}
              value={draft.currency}
              onChange={(event) =>
                set({ currency: event.target.value.toUpperCase() })
              }
            />
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={DRAFT_SPOT_CONTROLS.numberMin}>
            {t`Smallest value`}
          </Label>
          <Input
            id={DRAFT_SPOT_CONTROLS.numberMin}
            inputMode="decimal"
            placeholder={t`None`}
            value={draft.numberMin}
            onChange={(event) => set({ numberMin: event.target.value })}
            {...missingProps(
              DRAFT_SPOT_CONTROLS.numberMin,
              problems?.has("numberMin") === true,
            )}
          />
          {problems?.has("numberMin") ? (
            <Missing
              control={DRAFT_SPOT_CONTROLS.numberMin}
              text={t`Write a number, or leave it empty.`}
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={DRAFT_SPOT_CONTROLS.numberMax}>
            {t`Largest value`}
          </Label>
          <Input
            id={DRAFT_SPOT_CONTROLS.numberMax}
            inputMode="decimal"
            placeholder={t`None`}
            value={draft.numberMax}
            onChange={(event) => set({ numberMax: event.target.value })}
            {...missingProps(
              DRAFT_SPOT_CONTROLS.numberMax,
              problems?.has("numberMax") === true,
            )}
          />
          {problems?.has("numberMax") ? (
            <Missing
              control={DRAFT_SPOT_CONTROLS.numberMax}
              text={
                typedBound(draft.numberMax) === undefined
                  ? t`Write a number, or leave it empty.`
                  : t`The largest value is below the smallest.`
              }
            />
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t`Both included. Checked on every change, wherever it comes from; values already in the table stay until they are changed.`}
      </p>
    </>
  );
}

/**
 * What a short text takes (ADR 0141): its longest length, and a mask its
 * whole value fits.
 */
export function TextRulesSettings({ draft, set, problems }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={DRAFT_SPOT_CONTROLS.textMaxLength}>
            {t`Most characters`}
          </Label>
          <Input
            id={DRAFT_SPOT_CONTROLS.textMaxLength}
            inputMode="numeric"
            placeholder={t`None`}
            value={draft.textMaxLength}
            onChange={(event) => set({ textMaxLength: event.target.value })}
            {...missingProps(
              DRAFT_SPOT_CONTROLS.textMaxLength,
              problems?.has("textMaxLength") === true,
            )}
          />
          {problems?.has("textMaxLength") ? (
            <Missing
              control={DRAFT_SPOT_CONTROLS.textMaxLength}
              text={t`From 1 to 4,000, or leave it empty.`}
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={DRAFT_SPOT_CONTROLS.textMask}>{t`Pattern`}</Label>
          <Input
            id={DRAFT_SPOT_CONTROLS.textMask}
            className="font-mono"
            placeholder="AA-####"
            maxLength={MAX_MASK_LENGTH}
            value={draft.textMask}
            onChange={(event) => set({ textMask: event.target.value })}
            {...missingProps(
              DRAFT_SPOT_CONTROLS.textMask,
              problems?.has("textMask") === true,
            )}
          />
          {problems?.has("textMask") ? (
            <Missing
              control={DRAFT_SPOT_CONTROLS.textMask}
              text={t`End the pattern on something other than a lone \\.`}
            />
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t`In a pattern, # is a digit, A a letter from A to Z, * either, \\ makes the next sign itself, and every other sign is itself. Checked on every change, wherever it comes from; values already in the table stay until they are changed.`}
      </p>
    </div>
  );
}

/** How a day is written. */
export function DateSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="date-format">{t`Date format`}</Label>
      <Select
        id="date-format"
        value={draft.dateFormat}
        onChange={(event) => set({ dateFormat: event.target.value })}
      >
        <option value="eu">{t`European (31/12/2026)`}</option>
        <option value="us">{t`US (12/31/2026)`}</option>
        <option value="iso">ISO (2026-12-31)</option>
        <option value="long">{t`Long (December 31, 2026)`}</option>
        <option value="relative">{t`Relative (in 3 days)`}</option>
      </Select>
    </div>
  );
}

/** A score: out of how many, drawn with which symbol, in which colour. */
export function RatingSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="rating-max">{t`Maximum rating`}</Label>
        <Select
          id="rating-max"
          value={draft.ratingMax}
          onChange={(event) => set({ ratingMax: event.target.value })}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="rating-icon">{t`Icon`}</Label>
        <Select
          id="rating-icon"
          value={draft.ratingIcon}
          onChange={(event) => set({ ratingIcon: event.target.value })}
        >
          {RATING_ICONS.map((value) => (
            <option key={value} value={value}>
              {value === "star"
                ? t`Star`
                : value === "heart"
                  ? t`Heart`
                  : value === "thumb"
                    ? t`Thumb`
                    : value === "flag"
                      ? t`Flag`
                      : t`Fire`}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="rating-color">{t`Colour`}</Label>
        <Select
          id="rating-color"
          value={draft.ratingColor}
          onChange={(event) => set({ ratingColor: event.target.value })}
        >
          <option value="">{t`Default`}</option>
          {OPTION_COLORS.map((color) => (
            <option key={color} value={color}>
              {t(OPTION_COLOR_NAMES[color])}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** How a length of time is written. */
export function DurationSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="duration-format">{t`Format`}</Label>
      <Select
        id="duration-format"
        value={draft.durationFormat}
        onChange={(event) => set({ durationFormat: event.target.value })}
      >
        <option value="h:mm">h:mm</option>
        <option value="h:mm:ss">h:mm:ss</option>
        <option value="d h:mm">d h:mm</option>
      </Select>
    </div>
  );
}

/** One person or several, told or not when they are assigned. */
export function PeopleSettings({ draft, set }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.multiple}
          onChange={(event) => set({ multiple: event.target.checked })}
        />
        {t`Allow several people`}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.notify}
          onChange={(event) => set({ notify: event.target.checked })}
        />
        {t`Notify people when they are assigned`}
      </label>
    </div>
  );
}

/** A button: what it says, its colour, and what a press does. */
export function ButtonSettings({ draft, set, problems }: SettingsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="button-label">{t`Button text`}</Label>
          <Input
            id="button-label"
            maxLength={40}
            value={draft.buttonLabel}
            onChange={(event) => set({ buttonLabel: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t`Colour`}</Label>
          <div className="flex h-9 items-center">
            <OptionColorButton
              label={t`Colour of the button`}
              value={draft.buttonColor}
              onChange={(buttonColor) => set({ buttonColor })}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="button-action">{t`Action`}</Label>
        <Select
          id="button-action"
          value={draft.buttonAction}
          onChange={(event) =>
            set({
              buttonAction:
                event.target.value === "run_automation"
                  ? "run_automation"
                  : "open_url",
            })
          }
        >
          <option value="open_url">{t`Open a URL`}</option>
          <option value="run_automation">{t`Run an automation`}</option>
        </Select>
      </div>
      {draft.buttonAction === "open_url" ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="button-url">{t`URL`}</Label>
          <Input
            id={DRAFT_SPOT_CONTROLS.buttonUrl}
            placeholder="https://example.com/client/{{record_id}}"
            {...missingProps(
              DRAFT_SPOT_CONTROLS.buttonUrl,
              problems?.has("buttonUrl") === true,
            )}
            value={draft.buttonUrl}
            onChange={(event) => set({ buttonUrl: event.target.value })}
          />
          {problems?.has("buttonUrl") ? (
            <Missing
              control={DRAFT_SPOT_CONTROLS.buttonUrl}
              text={t`Give the address the button opens.`}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t`Insert a value with ${{ field: `{{${t`field_name`}}}` }} or ${{ id: "{{record_id}}" }}. Only http and https links open.`}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t`Then create an automation triggered by this button, from the view menu.`}
        </p>
      )}
    </div>
  );
}
