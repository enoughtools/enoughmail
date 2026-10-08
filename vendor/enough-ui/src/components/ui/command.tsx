"use client";

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "../../lib/utils.js"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog.js"

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    data-slot="command"
    className={cn(
      "flex h-full w-full flex-col bg-[var(--color-card)] border-2 border-[var(--color-ink)] shadow-[var(--shadow-palette)] font-sans rounded-none",
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

type CommandDialogProps = React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: CommandDialogProps) {
  const returnFocusRef = React.useRef<HTMLElement | null>(null)

  return (
    <Dialog {...props}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 [&_[cmdk-root]]:min-h-0 [&_[cmdk-root]]:border-0 [&_[cmdk-root]]:shadow-none",
          showCloseButton && "[&_[cmdk-input-wrapper]]:pr-[64px]",
          className
        )}
        showCloseButton={showCloseButton}
        onOpenAutoFocus={() => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef.current?.isConnected) {
            event.preventDefault()
            returnFocusRef.current.focus()
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
CommandDialog.displayName = "CommandDialog"

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div data-slot="command-input-wrapper" className="border-b border-[var(--color-ink)] px-[24px] py-[20px] focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--color-accent)]" cmdk-input-wrapper="">
    <div className="flex items-center gap-[14px]">
      <span aria-hidden="true" className="text-[var(--color-accent)] text-[18px]">⌕</span>
      <CommandPrimitive.Input
        ref={ref}
        data-slot="command-input"
        className={cn(
          "flex min-w-0 flex-1 bg-transparent text-[18px] text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-4)] disabled:cursor-not-allowed disabled:opacity-50 font-sans rounded-none",
          className
        )}
        {...props}
      />
    </div>
  </div>
))
CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    data-slot="command-list"
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
    {...props}
  />
))
CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    data-slot="command-empty"
    className={cn("py-6 text-center text-sm text-[var(--color-text-4)] font-sans", className)}
    {...props}
  />
))
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    data-slot="command-group"
    className={cn(
      "overflow-hidden text-[var(--color-text-main)] font-sans [&_[cmdk-group-heading]]:px-[24px] [&_[cmdk-group-heading]]:pt-[14px] [&_[cmdk-group-heading]]:pb-[6px] [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-sans [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-[var(--color-text-3)]",
      className
    )}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    data-slot="command-item"
    className={cn(
      "relative flex cursor-pointer select-none items-center px-[24px] py-[12px] text-[15px] outline-none aria-selected:bg-[var(--color-accent-soft)] aria-selected:border-l-[3px] aria-selected:border-l-[var(--color-accent)] aria-selected:pl-[21px] data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-[11px] font-sans tracking-widest text-[var(--color-text-4)]",
        className
      )}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
}

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    data-slot="command-separator"
    className={cn("-mx-1 h-px bg-[var(--color-ink)]", className)}
    {...props}
    // A listbox owns options and groups. This divider is only visual.
    aria-hidden="true"
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

export { CommandSeparator }
