"use client";

import { presentation } from '../../lib/presentation.js';

import { emptyMediaVariants } from '../../lib/variants.js';

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        presentation.Empty,
        className
      )}
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn(presentation.EmptyHeader, className)}
      {...props}
    />
  )
}



type EmptyMediaProps = React.ComponentProps<"div"> &
  VariantProps<typeof emptyMediaVariants>

function EmptyMedia({ className, variant, ...props }: EmptyMediaProps) {
  return (
    <div
      data-slot="empty-media"
      className={cn(emptyMediaVariants({ variant }), className)}
      {...props}
    />
  )
}

const EmptyIcon = EmptyMedia

function EmptyTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="empty-title"
      className={cn(
        presentation.EmptyTitle,
        className
      )}
      {...props}
    />
  )
}

function EmptyDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn(
        presentation.EmptyDescription,
        className
      )}
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        presentation.EmptyContent,
        className
      )}
      {...props}
    />
  )
}

interface EmptyActionProps extends React.ComponentProps<"div"> {
  asChild?: boolean
}

function EmptyAction({
  asChild = false,
  className,
  ...props
}: EmptyActionProps) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      data-slot="empty-action"
      className={cn(
        presentation.EmptyAction,
        className
      )}
      {...props}
    />
  )
}

export {
  Empty,
  EmptyAction,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyMedia,
  EmptyTitle,
  emptyMediaVariants,
}
