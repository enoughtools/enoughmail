"use client";

import { presentation } from '../../lib/presentation.js';

import { inputGroupAddonVariants, inputGroupButtonVariants, inputGroupButtonClasses, buttonVariants } from '../../lib/variants.js';

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"
import { Input } from "./input.js"
import { Textarea } from "./textarea.js"

const InputGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="group"
    data-slot="input-group"
    className={cn(
      presentation.InputGroup,
      className
    )}
    {...props}
  />
))
InputGroup.displayName = "InputGroup"



interface InputGroupAddonProps
  extends React.ComponentPropsWithoutRef<"div">,
    VariantProps<typeof inputGroupAddonVariants> {
  asChild?: boolean
}

const InputGroupAddon = React.forwardRef<HTMLDivElement, InputGroupAddonProps>(
  ({ className, align, asChild = false, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "div"

    return (
      <Comp
        ref={ref}
        data-slot="input-group-addon"
        data-align={align ?? "inline-start"}
        className={cn(inputGroupAddonVariants({ align }), className)}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || (event.target as Element).closest('button, a, input, textarea, select, [role=button]')) return;
          const control = event.currentTarget.closest('[data-slot=input-group]')?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-slot=input-group-control]');
          if (control && !control.disabled) control.focus();
        }}
        {...props}
      />
    )
  }
)
InputGroupAddon.displayName = "InputGroupAddon"



interface InputGroupButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof inputGroupButtonVariants> {
  asChild?: boolean
  variant?: VariantProps<typeof buttonVariants>['variant']
}

const InputGroupButton = React.forwardRef<
  HTMLButtonElement,
  InputGroupButtonProps
>(({ className, size, variant = 'ghost', asChild = false, type, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type ?? "button"}
      data-slot="input-group-button"
      data-size={size ?? 'xs'}
      className={cn(inputGroupButtonClasses({ variant, size }), className)}
      {...props}
    />
  )
})
InputGroupButton.displayName = "InputGroupButton"

const InputGroupText = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    data-slot="input-group-text"
    className={cn(
      presentation.InputGroupText,
      className
    )}
    {...props}
  />
))
InputGroupText.displayName = "InputGroupText"

const InputGroupInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<typeof Input>
>(({ className, ...props }, ref) => (
  <Input
    ref={ref}
    data-slot="input-group-control"
    className={cn(
      presentation.InputGroupInput,
      className
    )}
    {...props}
  />
))
InputGroupInput.displayName = "InputGroupInput"

const InputGroupTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<typeof Textarea>
>(({ className, ...props }, ref) => (
  <Textarea
    ref={ref}
    data-slot="input-group-control"
    className={cn(
      presentation.InputGroupTextarea,
      className
    )}
    {...props}
  />
))
InputGroupTextarea.displayName = "InputGroupTextarea"

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  inputGroupAddonVariants,
  inputGroupButtonVariants,
}
