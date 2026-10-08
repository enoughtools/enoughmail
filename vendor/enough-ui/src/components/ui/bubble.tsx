"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import type { VariantProps } from "class-variance-authority"
import { bubbleVariants, bubbleReactionsVariants, conversation } from "../../lib/conversation.js"
import { cn } from "../../lib/utils.js"

export type BubbleProps = React.ComponentProps<"div"> & VariantProps<typeof bubbleVariants> & { align?: "start" | "end" }
export type BubbleContentProps = React.ComponentProps<"div"> & { asChild?: boolean }
export type BubbleReactionsProps = React.ComponentProps<"div"> & VariantProps<typeof bubbleReactionsVariants>

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="bubble-group" className={cn(conversation.BubbleGroup, className)} {...props} />
}
function Bubble({ variant = "default", align = "start", className, ...props }: BubbleProps) {
  return <div data-slot="bubble" data-variant={variant} data-align={align} className={cn(bubbleVariants({ variant }), className)} {...props} />
}
function BubbleContent({ asChild = false, className, ...props }: BubbleContentProps) {
  const Comp = asChild ? Slot : "div"
  return <Comp data-slot="bubble-content" className={cn(conversation.BubbleContent, className)} {...props} />
}
function BubbleReactions({ side = "bottom", align = "end", className, ...props }: BubbleReactionsProps) {
  return <div data-slot="bubble-reactions" data-side={side} data-align={align} className={cn(bubbleReactionsVariants({ side, align }), className)} {...props} />
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions, bubbleVariants, bubbleReactionsVariants }
