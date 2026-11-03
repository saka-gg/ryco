import {
  type CustomSnoozeInput,
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
} from "@ryco/shared/threadSnooze";
import { useId, useState } from "react";

import { mountDialog } from "./chat/mountDialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

type SnoozeUnit = Extract<CustomSnoozeInput, { mode: "duration" }>["unit"];

const UNIT_LABELS: Record<SnoozeUnit, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};

/** Today's local date, the earliest a date field offers. */
function localToday(): string {
  return localSnoozeDate(new Date());
}

function isSnoozeUnit(value: unknown): value is SnoozeUnit {
  return value === "minutes" || value === "hours" || value === "days";
}

/**
 * Asks for a custom snooze: a local date and time, or a duration that starts
 * when the user confirms. Resolves the wake instant, or null when dismissed.
 * Loaded on demand through `requestCustomSnooze`.
 */
export function openCustomSnoozeDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <CustomSnoozeDialog
        onDone={(snoozedUntil) => {
          resolve(snoozedUntil);
          close();
        }}
      />
    ));
  });
}

export function CustomSnoozeDialog(props: {
  readonly onDone: (snoozedUntil: string | null) => void;
}) {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => localSnoozeDate(initial));
  const [time, setTime] = useState(() => localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<SnoozeUnit>("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput = mode === "date" ? { mode, date, time } : { mode, amount, unit };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onDone(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm" bottomStickOnMobile={false}>
        <form
          // The wake rule below checks every field; a native check would stop it first.
          noValidate
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            props.onDone(snoozedUntil);
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when snoozed threads return to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label="Schedule type"
                className="w-full *:flex-1"
                variant="outline"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="date">Date and time</Toggle>
                <Toggle value="duration">Duration</Toggle>
              </ToggleGroup>
              {mode === "date" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-date`}>Date</Label>
                    <Input
                      nativeInput
                      id={`${id}-date`}
                      type="date"
                      required
                      min={localToday()}
                      value={date}
                      onChange={(event) => {
                        setDate(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-time`}>Time</Label>
                    <Input
                      nativeInput
                      id={`${id}-time`}
                      type="time"
                      required
                      value={time}
                      onChange={(event) => {
                        setTime(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-amount`}>Snooze for</Label>
                    <Input
                      nativeInput
                      id={`${id}-amount`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      required
                      value={amount}
                      onChange={(event) => {
                        setAmount(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-unit`}>Unit</Label>
                    <Select
                      value={unit}
                      onValueChange={(value) => {
                        if (isSnoozeUnit(value)) setUnit(value);
                        setError(null);
                      }}
                    >
                      <SelectTrigger id={`${id}-unit`} className="min-w-0">
                        <SelectValue>{UNIT_LABELS[unit]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {(Object.keys(UNIT_LABELS) as SnoozeUnit[]).map((value) => (
                          <SelectItem key={value} hideIndicator value={value}>
                            {UNIT_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
              )}
              {error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onDone(null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
