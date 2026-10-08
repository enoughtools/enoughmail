"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "../../lib/utils.js"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { size?: "sm" | "default" }
>(({ className, size = "default", ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    data-size={size}
    className={cn(
      "peer relative inline-flex shrink-0 cursor-pointer items-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans shadow-none transition-colors after:absolute after:-inset-x-2 after:-inset-y-2",
      size === "sm" ? "h-5 w-9" : "h-6 w-11",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]",
      "data-[state=checked]:bg-[var(--color-accent)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        "pointer-events-none block translate-x-1 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-none transition-transform rtl:-translate-x-1",
        size === "sm" ? "size-3 data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px]" : "size-4 data-[state=checked]:translate-x-[22px] rtl:data-[state=checked]:-translate-x-[22px]"
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
