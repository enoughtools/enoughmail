"use client";

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"

import { cn } from "../../lib/utils.js"
import { Label } from "./label.js"

const Form = FormProvider

type FormFieldContextValue = { name: FieldPath<FieldValues> }
const FormFieldContext = React.createContext<FormFieldContextValue | null>(null)
const FormItemContext = React.createContext<{ id: string } | null>(null)

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

function useFormField() {
  const field = React.useContext(FormFieldContext)
  const item = React.useContext(FormItemContext)
  const form = useFormContext()

  if (!field) throw new Error("useFormField must be used within <FormField>.")
  if (!item) throw new Error("useFormField must be used within <FormItem>.")
  if (!form) throw new Error("useFormField must be used within <Form>.")

  const formState = useFormState({ control: form.control, name: field.name })
  return {
    id: item.id,
    name: field.name,
    formItemId: `${item.id}-form-item`,
    formDescriptionId: `${item.id}-form-item-description`,
    formMessageId: `${item.id}-form-item-message`,
    ...form.getFieldState(field.name, formState),
  }
}

const FormItem = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => {
    const id = React.useId()
    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={ref} data-slot="form-item" className={cn("grid gap-2 font-sans", className)} {...props} />
      </FormItemContext.Provider>
    )
  },
)
FormItem.displayName = "FormItem"

const FormLabel = React.forwardRef<React.ComponentRef<typeof Label>, React.ComponentPropsWithoutRef<typeof Label>>(
  ({ className, ...props }, ref) => {
    const { error, formItemId } = useFormField()
    return (
      <Label
        {...props}
        ref={ref}
        data-slot="form-label"
        data-error={Boolean(error)}
        className={cn("data-[error=true]:text-[var(--color-warn)]", className)}
        htmlFor={formItemId}
      />
    )
  },
)
FormLabel.displayName = "FormLabel"

const FormControl = React.forwardRef<React.ComponentRef<typeof Slot>, React.ComponentPropsWithoutRef<typeof Slot>>(
  ({ children, ...props }, ref) => {
    const { error, formItemId, formDescriptionId, formMessageId } = useFormField()
    const child = React.isValidElement<React.HTMLAttributes<HTMLElement>>(children) ? children : null
    const descriptions = [
      props["aria-describedby"],
      child?.props["aria-describedby"],
      formDescriptionId,
      error ? formMessageId : null,
    ].filter(Boolean).join(" ").split(/\s+/)
    const controlProps = {
      "data-slot": "form-control",
      id: formItemId,
      "aria-describedby": [...new Set(descriptions)].join(" "),
      "aria-invalid": error ? true : (child?.props["aria-invalid"] ?? props["aria-invalid"] ?? false),
    }

    return (
      <Slot {...props} {...controlProps} ref={ref}>
        {child ? React.cloneElement(child, controlProps) : children}
      </Slot>
    )
  },
)
FormControl.displayName = "FormControl"

const FormDescription = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<"p">>(
  ({ className, ...props }, ref) => {
    const { formDescriptionId } = useFormField()
    return <p {...props} ref={ref} data-slot="form-description" id={formDescriptionId} className={cn("font-sans text-sm leading-5 text-[var(--color-text-3)]", className)} />
  },
)
FormDescription.displayName = "FormDescription"

const FormMessage = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<"p">>(
  ({ className, children, ...props }, ref) => {
    const { error, formMessageId } = useFormField()
    const body = error ? String(error.message ?? "") : children
    if (!body) return null
    return (
      <p {...props} ref={ref} data-slot="form-message" id={formMessageId} className={cn("border-l-2 border-[var(--color-warn)] pl-2 font-sans text-sm leading-5 text-[var(--color-warn)]", className)}>
        {body}
      </p>
    )
  },
)
FormMessage.displayName = "FormMessage"

export { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage, useFormField }
