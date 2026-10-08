"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "../../lib/utils.js"
import { normalizeProgress, progressClasses } from "../../lib/progress.js"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, max = 100, "aria-label": ariaLabel = "Progress", ...props }, ref) => {
  const progress = normalizeProgress(value, max)

  return (
    <ProgressPrimitive.Root
      ref={ref}
      data-slot="progress"
      className={cn(progressClasses.root, className)}
      aria-label={ariaLabel}
      value={progress.value}
      max={progress.max}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={progressClasses.indicator}
        style={{ transform: `translateX(-${100 - progress.percentage}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
