"use client";

import { presentation } from '../../lib/presentation.js';

import { itemVariants, itemMediaVariants } from '../../lib/variants.js';

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"
import { Separator } from './separator.js'



interface ItemProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof itemVariants> {
  asChild?: boolean
}

function Item({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ItemProps) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      data-slot="item"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(itemVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      role="group"
      className={cn(presentation.ItemGroup, className)}
      {...props}
    />
  )
}



interface ItemMediaProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof itemMediaVariants> {}

function ItemMedia({ className, variant = 'default', ...props }: ItemMediaProps) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant }), className)}
      {...props}
    />
  )
}

const ItemImage = ItemMedia

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(presentation.ItemContent, className)}
      {...props}
    />
  )
}

function ItemTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="item-title"
      className={cn(
        presentation.ItemTitle,
        className
      )}
      {...props}
    />
  )
}

function ItemDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        presentation.ItemDescription,
        className
      )}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn(
        presentation.ItemActions,
        className
      )}
      {...props}
    />
  )
}

const ItemAction = ItemActions

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(presentation.ItemHeader, className)}
      {...props}
    />
  )
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        presentation.ItemFooter,
        className
      )}
      {...props}
    />
  )
}

function ItemSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      className={className}
      {...props}
    />
  )
}

export {
  Item,
  ItemAction,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemImage,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  itemMediaVariants,
  itemVariants,
}
