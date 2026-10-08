"use client";

import * as React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"

import { cn } from "../../lib/utils.js"

const Accordion = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Root>
>((props, ref) => {
  const className = props.className
  const rootProps =
    props.type === "single"
      ? { collapsible: true, ...props }
      : props

  return (
    <AccordionPrimitive.Root
      ref={ref}
      data-slot="accordion"
      {...rootProps}
      className={cn(
        "w-full border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] rounded-none",
        className
      )}
    />
  )
})
Accordion.displayName = AccordionPrimitive.Root.displayName

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    data-slot="accordion-item"
    className={cn(
      "border-b border-[var(--color-ink)] last:border-b-0 rounded-none",
      className
    )}
    {...props}
  />
))
AccordionItem.displayName = "AccordionItem"

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      data-slot="accordion-trigger"
      className={cn(
        "group flex min-h-[52px] flex-1 cursor-pointer items-center justify-between gap-[16px] bg-[var(--color-surface)] px-[20px] py-[14px] text-left font-sans text-[15px] font-semibold text-[var(--color-text-main)] transition-colors hover:bg-[var(--color-accent-soft)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-[var(--color-paper)] rounded-none",
        className
      )}
      {...props}
    >
      <span>{children}</span>
      <span
        aria-hidden="true"
        className="relative size-[18px] shrink-0 font-sans text-[18px] font-normal leading-[18px] text-[var(--color-accent)]"
      >
        <span className="absolute inset-0 text-center motion-safe:transition-opacity group-data-[state=open]:opacity-0">+</span>
        <span className="absolute inset-0 text-center opacity-0 motion-safe:transition-opacity group-data-[state=open]:opacity-100">−</span>
      </span>
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
))
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    data-slot="accordion-content"
    className="overflow-hidden border-t border-[var(--color-ink)] bg-[var(--color-card)] font-sans text-[14px] text-[var(--color-text-2)] motion-safe:data-[state=closed]:animate-[accordion-up_200ms_ease-out] motion-safe:data-[state=open]:animate-[accordion-down_200ms_ease-out] rounded-none"
    {...props}
  >
    <div className={cn("px-[20px] py-[18px] leading-6", className)}>
      {children}
    </div>
  </AccordionPrimitive.Content>
))
AccordionContent.displayName = AccordionPrimitive.Content.displayName

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
