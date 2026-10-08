"use client"

import * as React from "react"
import { conversation } from "../../lib/conversation.js"
import { cn } from "../../lib/utils.js"

export type MessageProps = React.ComponentProps<"div"> & { align?: "start" | "end" }

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-group" className={cn(conversation.MessageGroup, className)} {...props} />
}
function Message({ className, align = "start", ...props }: MessageProps) {
  return <div data-slot="message" data-align={align} className={cn(conversation.Message, className)} {...props} />
}
function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-avatar" className={cn(conversation.MessageAvatar, className)} {...props} />
}
function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-content" className={cn(conversation.MessageContent, className)} {...props} />
}
function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-header" className={cn(conversation.MessageHeader, className)} {...props} />
}
function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-footer" className={cn(conversation.MessageFooter, className)} {...props} />
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader }
