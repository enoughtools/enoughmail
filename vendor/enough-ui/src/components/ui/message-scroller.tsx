"use client"

import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller as usePrimitiveMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
  type MessageScrollerScrollOptions,
} from "@shadcn/react/message-scroller"

import { cn } from "../../lib/utils.js"
import { Button } from "./button.js"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(reducedMotionQuery).matches
}

function subscribeReducedMotion(listener: () => void) {
  if (typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

function resolveScrollOptions(options?: MessageScrollerScrollOptions) {
  return options?.behavior === "smooth" && prefersReducedMotion()
    ? { ...options, behavior: "auto" as const }
    : options
}

/** Imperative commands share the primitive's API and honor reduced motion. */
function useMessageScroller() {
  const commands = usePrimitiveMessageScroller()
  return React.useMemo(() => ({
    scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) =>
      commands.scrollToMessage(messageId, resolveScrollOptions(options)),
    scrollToEnd: (options?: MessageScrollerScrollOptions) =>
      commands.scrollToEnd(resolveScrollOptions(options)),
    scrollToStart: (options?: MessageScrollerScrollOptions) =>
      commands.scrollToStart(resolveScrollOptions(options)),
  }), [commands])
}

type MessageScrollerProviderProps = React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
type MessageScrollerProps = React.ComponentProps<typeof MessageScrollerPrimitive.Root>
type MessageScrollerViewportProps = React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>
type MessageScrollerContentProps = React.ComponentProps<typeof MessageScrollerPrimitive.Content>
type MessageScrollerItemProps = React.ComponentProps<typeof MessageScrollerPrimitive.Item>
type MessageScrollerButtonProps = React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">

function MessageScrollerProvider(props: MessageScrollerProviderProps) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({ className, ...props }: MessageScrollerProps) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] font-sans text-[var(--color-ink)]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({ className, ...props }: MessageScrollerViewportProps) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [scrollbar-width:thin] data-[pending-scroll]:invisible outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] motion-reduce:scroll-auto",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({ className, ...props }: MessageScrollerContentProps) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6 p-4 sm:p-6", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({ className, scrollAnchor = false, ...props }: MessageScrollerItemProps) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  behavior = "smooth",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  ...props
}: MessageScrollerButtonProps) {
  const reducedMotion = React.useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false
  )
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-variant={variant}
      data-size={size}
      direction={direction}
      behavior={reducedMotion && behavior === "smooth" ? "auto" : behavior}
      className={cn(
        "absolute start-1/2 z-10 -translate-x-1/2 shadow-[var(--shadow-card)] transition-[translate,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:opacity-0 data-[direction=end]:bottom-4 data-[direction=start]:top-4 rtl:translate-x-1/2 motion-reduce:transition-none",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className={direction === "start" ? "rotate-180" : undefined}
          >
            <path d="M12 5v14m-7-7 7 7 7-7" />
          </svg>
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
export type {
  MessageScrollerProviderProps,
  MessageScrollerProps,
  MessageScrollerViewportProps,
  MessageScrollerContentProps,
  MessageScrollerItemProps,
  MessageScrollerButtonProps,
}
export type {
  MessageScrollerDefaultScrollPosition,
  MessageScrollerScrollAlign,
  MessageScrollerScrollOptions,
  MessageScrollerScrollable,
  MessageScrollerVisibilityState,
} from "@shadcn/react/message-scroller"
