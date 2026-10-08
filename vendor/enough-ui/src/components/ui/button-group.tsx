"use client";

import { presentation } from '../../lib/presentation.js';

import { buttonGroupVariants } from '../../lib/variants.js';

import * as React from "react"
import * as SeparatorPrimitive from "@radix-ui/react-separator"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"



type ButtonGroupProps = React.ComponentPropsWithoutRef<"div"> &
  VariantProps<typeof buttonGroupVariants>

const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, orientation = "horizontal", ...props }, ref) => (
    <div
      ref={ref}
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  )
)
ButtonGroup.displayName = "ButtonGroup"

type ButtonGroupTextProps = React.ComponentPropsWithoutRef<"div"> & {
  asChild?: boolean
}

const ButtonGroupText = React.forwardRef<HTMLDivElement, ButtonGroupTextProps>(
  ({ className, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "div"

    return (
      <Comp
        ref={ref}
        data-slot="button-group-text"
        className={cn(
          presentation.ButtonGroupText,
          className
        )}
        {...props}
      />
    )
  }
)
ButtonGroupText.displayName = "ButtonGroupText"

type ButtonGroupSeparatorProps = React.ComponentPropsWithoutRef<
  typeof SeparatorPrimitive.Root
>

const ButtonGroupSeparator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  ButtonGroupSeparatorProps
>(({ className, orientation = "vertical", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    data-slot="button-group-separator"
    className={cn(
      presentation.ButtonGroupSeparator,
      orientation === "vertical" ? "my-0 w-px" : "mx-0 h-px",
      className
    )}
    {...props}
  />
))
ButtonGroupSeparator.displayName = SeparatorPrimitive.Root.displayName

export {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  buttonGroupVariants,
}
export type { ButtonGroupProps, ButtonGroupSeparatorProps, ButtonGroupTextProps }
