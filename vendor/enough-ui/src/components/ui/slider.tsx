"use client"

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "../../lib/utils.js"

type SliderThumbProps = React.ComponentProps<typeof SliderPrimitive.Thumb>

interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** Accessible names for individual handles, useful for minimum/maximum ranges. */
  thumbLabels?: readonly string[]
  /** Configure each handle, including its accessible value text, events, and ref. */
  thumbProps?: readonly SliderThumbProps[] | ((index: number, value: number) => SliderThumbProps)
}

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, defaultValue, value, onValueChange, min = 0, max = 100, thumbLabels, thumbProps,
  "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy, "aria-valuetext": ariaValueText,
  "aria-invalid": ariaInvalid, "aria-errormessage": ariaErrorMessage,
  ...props }, ref) => {
  const [internalValues, setInternalValues] = React.useState(() => defaultValue ?? [min])
  const values = value ?? internalValues

  return (
    <SliderPrimitive.Root
      ref={ref}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      onValueChange={(nextValues) => {
        if (value === undefined) setInternalValues(nextValues)
        onValueChange?.(nextValues)
      }}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[orientation=vertical]:h-48 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col shadow-none",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute rounded-none bg-[var(--color-accent)] data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {values.map((currentValue, index) => {
        const handleProps = typeof thumbProps === "function" ? thumbProps(index, currentValue) : thumbProps?.[index]
        const label = thumbLabels?.[index]
        const hasOwnName = label !== undefined || handleProps?.["aria-label"] !== undefined || handleProps?.["aria-labelledby"] !== undefined
        return <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          {...(!hasOwnName && (ariaLabel !== undefined || ariaLabelledBy !== undefined)
            ? { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy }
            : {})}
          aria-describedby={ariaDescribedBy}
          aria-valuetext={ariaValueText}
          aria-invalid={ariaInvalid}
          aria-errormessage={ariaErrorMessage}
          {...(label !== undefined ? { "aria-label": label } : {})}
          {...handleProps}
          className={cn("block size-5 shrink-0 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-none transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-50", handleProps?.className)}
        />
      })}
    </SliderPrimitive.Root>
  )
})
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
export type { SliderProps, SliderThumbProps }
