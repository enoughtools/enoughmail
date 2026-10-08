"use client"

import * as React from "react"
import { format, type Locale } from "date-fns"
import { CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { cn } from "../../lib/utils.js"
import { Button, type ButtonProps } from "./button.js"
import { Calendar, type CalendarProps } from "./calendar.js"
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js"

type DatePickerCommonProps = {
  /** A meaningful name such as "Departure date". The current value is appended. */
  label: string
  placeholder?: string
  disabled?: boolean
  id?: string
  name?: string
  className?: string
  locale?: Locale
  dateFormat?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Defaults to true for a single date and false for a range. */
  closeOnSelect?: boolean
  triggerProps?: Omit<ButtonProps, "children" | "disabled" | "id" | "className">
  popoverProps?: Omit<React.ComponentProps<typeof PopoverContent>, "children">
}

type SingleDatePickerProps = DatePickerCommonProps & {
  mode?: "single"
  value?: Date
  defaultValue?: Date
  onValueChange?: (date: Date | undefined) => void
  calendarProps?: Omit<Extract<CalendarProps, { mode: "single" }>, "mode" | "selected" | "onSelect" | "required">
}

type RangeDatePickerProps = DatePickerCommonProps & {
  mode: "range"
  value?: DateRange
  defaultValue?: DateRange
  onValueChange?: (range: DateRange | undefined) => void
  calendarProps?: Omit<Extract<CalendarProps, { mode: "range" }>, "mode" | "selected" | "onSelect" | "required">
}

type DatePickerProps = SingleDatePickerProps | RangeDatePickerProps

/** Optional convenience composition. Calendar + Popover can also be composed directly. */
function DatePicker(props: DatePickerProps) {
  const {
    label,
    placeholder = props.mode === "range" ? "Pick a date range" : "Pick a date",
    disabled,
    id,
    name,
    className,
    locale,
    dateFormat = "PPP",
    open,
    defaultOpen = false,
    onOpenChange,
    closeOnSelect = props.mode !== "range",
    triggerProps,
    calendarProps,
    popoverProps,
  } = props
  const [internalValue, setInternalValue] = React.useState<Date | DateRange | undefined>(props.defaultValue)
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  // Presence, rather than undefined, distinguishes a controlled empty selection.
  const controlled = Object.prototype.hasOwnProperty.call(props, "value")
  const selected = controlled ? props.value : internalValue
  const isOpen = open ?? internalOpen
  const range = props.mode === "range" ? selected as DateRange | undefined : undefined
  const date = props.mode !== "range" ? selected as Date | undefined : undefined
  const formatDate = (value: Date) => format(value, dateFormat, { locale })
  const valueLabel = range?.from
    ? range.to ? `${formatDate(range.from)} – ${formatDate(range.to)}` : `${formatDate(range.from)} – …`
    : date ? formatDate(date) : placeholder

  function setOpen(next: boolean) {
    if (open === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  function selectDate(next: Date | undefined) {
    if (!controlled) setInternalValue(next)
    if (props.mode !== "range") props.onValueChange?.(next)
    if (closeOnSelect && next) setOpen(false)
  }

  function selectRange(next: DateRange | undefined) {
    if (!controlled) setInternalValue(next)
    if (props.mode === "range") props.onValueChange?.(next)
    if (closeOnSelect && next?.from && next.to) setOpen(false)
  }

  // Format dates without converting to UTC: these are calendar days, not instants.
  const inputDate = (value?: Date) => value ? format(value, "yyyy-MM-dd") : ""

  return (
    <>
      <Popover open={isOpen} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            {...triggerProps}
            id={id}
            disabled={disabled}
            aria-label={`${label}: ${valueLabel}`}
            data-slot="date-picker-trigger"
            data-empty={!date && !range?.from}
            className={cn("h-auto min-h-[41px] w-full justify-start whitespace-normal px-3 py-2 text-start font-normal data-[empty=true]:text-[var(--color-text-3)]", className)}
          >
            <CalendarIcon aria-hidden="true" className="shrink-0" />
            <span>{valueLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-[calc(100vw-1rem)] p-0" {...popoverProps}>
          {props.mode === "range" ? (
            <Calendar
              locale={locale}
              autoFocus
              resetOnSelect
              defaultMonth={range?.from}
              {...calendarProps}
              mode="range"
              selected={range}
              onSelect={selectRange}
              aria-label={label}
            />
          ) : (
            <Calendar
              locale={locale}
              autoFocus
              defaultMonth={date}
              {...calendarProps}
              mode="single"
              selected={date}
              onSelect={selectDate}
              aria-label={label}
            />
          )}
        </PopoverContent>
      </Popover>
      {name && (props.mode === "range" ? (
        <>
          <input type="hidden" name={`${name}.from`} value={inputDate(range?.from)} disabled={disabled} />
          <input type="hidden" name={`${name}.to`} value={inputDate(range?.to)} disabled={disabled} />
        </>
      ) : <input type="hidden" name={name} value={inputDate(date)} disabled={disabled} />)}
    </>
  )
}

export { DatePicker }
export type { DatePickerProps, SingleDatePickerProps, RangeDatePickerProps }
