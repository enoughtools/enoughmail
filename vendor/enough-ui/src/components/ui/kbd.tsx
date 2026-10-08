"use client";

import { presentation } from '../../lib/presentation.js';

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "../../lib/utils.js"

interface KbdProps extends React.ComponentPropsWithoutRef<"kbd"> {
  asChild?: boolean
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const Comp = asChild ? Slot : "kbd"

    return (
      <Comp
        ref={ref}
        data-slot="kbd"
        className={cn(
          presentation.Kbd,
          className
        )}
        {...props}
      />
    )
  }
)
Kbd.displayName = "Kbd"

const KbdGroup = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    role="group"
    data-slot="kbd-group"
    className={cn(presentation.KbdGroup, className)}
    {...props}
  />
))
KbdGroup.displayName = "KbdGroup"

export { Kbd, KbdGroup }
export type { KbdProps }
