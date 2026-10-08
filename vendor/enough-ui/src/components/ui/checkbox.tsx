"use client";

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"

import { cn } from "../../lib/utils.js"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    data-slot="checkbox"
    className={cn(
      "peer relative h-[18px] w-[18px] shrink-0 border border-[var(--color-ink)] bg-[var(--color-surface)] after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--color-ink)] data-[state=checked]:border-[var(--color-ink)] data-[state=checked]:text-[var(--color-surface)] rounded-none",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className={cn("group/checkbox-indicator flex items-center justify-center text-current")}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-3 group-data-[state=indeterminate]/checkbox-indicator:hidden"><path d="m3 8 3 3 7-7" /></svg>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" className="hidden size-3 group-data-[state=indeterminate]/checkbox-indicator:block"><path d="M3 8h10" /></svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
