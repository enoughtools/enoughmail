"use client"

import { presentation } from '../../lib/presentation.js';

import { fieldVariants } from '../../lib/variants.js';

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"



const Field = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof fieldVariants>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <div
    ref={ref}
    role="group"
    data-slot="field"
    data-orientation={orientation}
    className={cn(fieldVariants({ orientation }), className)}
    {...props}
  />
))
Field.displayName = "Field"

const FieldSet = React.forwardRef<
  HTMLFieldSetElement,
  React.FieldsetHTMLAttributes<HTMLFieldSetElement>
>(({ className, ...props }, ref) => (
  <fieldset
    ref={ref}
    data-slot="field-set"
    className={cn(
      presentation.FieldSet,
      className
    )}
    {...props}
  />
))
FieldSet.displayName = "FieldSet"

const FieldLegend = React.forwardRef<
  HTMLLegendElement,
  React.HTMLAttributes<HTMLLegendElement> & {
    variant?: "legend" | "label"
  }
>(({ className, variant = "legend", ...props }, ref) => (
  <legend
    ref={ref}
    data-slot="field-legend"
    data-variant={variant}
    className={cn(
      presentation.FieldLegend,
      className
    )}
    {...props}
  />
))
FieldLegend.displayName = "FieldLegend"

const FieldGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="field-group"
    className={cn(presentation.FieldGroup, className)}
    {...props}
  />
))
FieldGroup.displayName = "FieldGroup"

const FieldContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="field-content"
    className={cn(presentation.FieldContent, className)}
    {...props}
  />
))
FieldContent.displayName = "FieldContent"

const FieldLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    data-slot="field-label"
    className={cn(
      presentation.FieldLabel,
      className
    )}
    {...props}
  />
))
FieldLabel.displayName = LabelPrimitive.Root.displayName

const FieldTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="field-title"
    className={cn(
      presentation.FieldTitle,
      className
    )}
    {...props}
  />
))
FieldTitle.displayName = "FieldTitle"

const FieldDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="field-description"
    className={cn(
      presentation.FieldDescription,
      className
    )}
    {...props}
  />
))
FieldDescription.displayName = "FieldDescription"

type FieldErrorItem = { message?: string } | undefined

const FieldError = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { errors?: FieldErrorItem[] }
>(({ className, children, errors, ...props }, ref) => {
  const uniqueErrors = React.useMemo(
    () =>
      Array.from(
        new Map(
          (errors ?? [])
            .filter((error): error is { message?: string } => Boolean(error?.message))
            .map((error) => [error.message, error])
        ).values()
      ),
    [errors]
  )

  if (!children && uniqueErrors.length === 0) return null

  return (
    <div
      ref={ref}
      role="alert"
      aria-live="polite"
      data-slot="field-error"
      className={cn(
        presentation.FieldError,
        className
      )}
      {...props}
    >
      {children ??
        (uniqueErrors.length === 1 ? (
          uniqueErrors[0]?.message
        ) : (
          <ul className="ml-4 list-square space-y-1">
            {uniqueErrors.map((error) => (
              <li key={error.message}>{error.message}</li>
            ))}
          </ul>
        ))}
    </div>
  )
})
FieldError.displayName = "FieldError"

const FieldSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    data-slot="field-separator"
    className={cn(
      presentation.FieldSeparator,
      className
    )}
    {...props}
  >
    {children ? (
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-surface)] px-2 font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-3)]">
        {children}
      </span>
    ) : null}
  </div>
))
FieldSeparator.displayName = "FieldSeparator"

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  fieldVariants,
}
