"use client";

import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"

import { cn } from "../../lib/utils.js"
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js"

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger
const ContextMenuGroup = ContextMenuPrimitive.Group
const ContextMenuPortal = ContextMenuPrimitive.Portal
const ContextMenuSub = ContextMenuPrimitive.Sub
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center border border-transparent px-[16px] py-[10px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] focus:pl-[13px] data-[state=open]:border-l-[3px] data-[state=open]:border-l-[var(--color-accent)] data-[state=open]:bg-[var(--color-accent-soft)] data-[state=open]:pl-[13px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-[32px] focus:pl-[29px] data-[state=open]:pl-[29px]",
      className
    )}
    {...props}
  >
    {children}
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn(directionIconClass, "ms-auto rtl:rotate-180")}>
      <path d={directionChevronPaths.right} />
    </svg>
  </ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    sideOffset={2}
    alignOffset={-5}
    className={cn(
      "z-50 min-w-[12rem] overflow-hidden border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] font-sans text-[var(--color-text-main)] shadow-[var(--shadow-card)] rounded-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className
    )}
    {...props}
  />
))
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-[12rem] overflow-hidden border border-[var(--color-ink)] bg-[var(--color-surface)] p-[4px] font-sans text-[var(--color-text-main)] shadow-[var(--shadow-palette)] rounded-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center border border-transparent px-[16px] py-[10px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] focus:pl-[13px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-[32px] focus:pl-[29px]",
      className
    )}
    {...props}
  />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center border border-transparent py-[10px] pl-[32px] pr-[16px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] focus:pl-[29px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-[8px] flex size-[16px] items-center justify-center rounded-none">
      <ContextMenuPrimitive.ItemIndicator>
        <span aria-hidden="true" className="text-[14px] leading-none">
          ✓
        </span>
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
))
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center border border-transparent py-[10px] pl-[32px] pr-[16px] font-sans text-[15px] outline-none rounded-none transition-colors hover:bg-[var(--color-hover)] focus:border-l-[3px] focus:border-l-[var(--color-accent)] focus:bg-[var(--color-hover-strong)] focus:pl-[29px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-[8px] flex size-[16px] items-center justify-center rounded-none">
      <ContextMenuPrimitive.ItemIndicator>
        <span aria-hidden="true" className="text-[11px] leading-none">
          ●
        </span>
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
))
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-[16px] py-[6px] font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-3)] rounded-none",
      inset && "pl-[32px]",
      className
    )}
    {...props}
  />
))
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn(
      "-mx-[4px] my-[4px] h-px bg-[var(--color-ink)] rounded-none",
      className
    )}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "ml-auto pl-[16px] font-sans text-[11px] tracking-widest text-[var(--color-text-4)]",
      className
    )}
    {...props}
  />
)
ContextMenuShortcut.displayName = "ContextMenuShortcut"

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
