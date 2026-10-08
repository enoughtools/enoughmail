"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import type { VariantProps } from "class-variance-authority"
import { attachmentVariants, attachmentMediaVariants, conversation } from "../../lib/conversation.js"
import { cn } from "../../lib/utils.js"
import { Button, type ButtonProps } from "./button.js"

export type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done"
export type AttachmentProps = React.ComponentProps<"div"> & VariantProps<typeof attachmentVariants> & { state?: AttachmentState }
export type AttachmentMediaProps = React.ComponentProps<"div"> & VariantProps<typeof attachmentMediaVariants>
export type AttachmentTriggerProps = React.ComponentProps<"button"> & { asChild?: boolean }

function Attachment({ className, state = "done", size = "default", orientation = "horizontal", ...props }: AttachmentProps) {
  return <div data-slot="attachment" data-state={state} data-size={size} data-orientation={orientation} aria-busy={state === "uploading" || state === "processing" || undefined} className={cn(attachmentVariants({ size, orientation }), className)} {...props} />
}
function AttachmentMedia({ className, variant = "icon", ...props }: AttachmentMediaProps) {
  return <div data-slot="attachment-media" data-variant={variant} className={cn(attachmentMediaVariants({ variant }), className)} {...props} />
}
function AttachmentContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-content" className={cn(conversation.AttachmentContent, className)} {...props} />
}
function AttachmentTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="attachment-title" className={cn(conversation.AttachmentTitle, className)} {...props} />
}
function AttachmentDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="attachment-description" className={cn(conversation.AttachmentDescription, className)} {...props} />
}
function AttachmentActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-actions" className={cn(conversation.AttachmentActions, className)} {...props} />
}
function AttachmentAction({ className, variant = "ghost", size = "icon-xs", asChild = false, type, ...props }: ButtonProps) {
  return <Button data-slot="attachment-action" variant={variant} size={size} asChild={asChild} type={asChild ? type : (type ?? "button")} className={className} {...props} />
}
function AttachmentTrigger({ className, asChild = false, type = "button", ...props }: AttachmentTriggerProps) {
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="attachment-trigger" type={asChild ? undefined : type} className={cn(conversation.AttachmentTrigger, className)} {...props} />
}
function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-group" className={cn(conversation.AttachmentGroup, className)} {...props} />
}

export { Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger, attachmentVariants, attachmentMediaVariants }
