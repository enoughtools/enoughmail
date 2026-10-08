"use client"

import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"

const toggleGroupVariants = cva(
  "inline-flex w-fit items-stretch rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-palette)]",
  {
    variants: {
      orientation: {
        horizontal: "flex-row",
        vertical: "flex-col",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  }
)

const toggleGroupItemVariants = cva(
  "relative inline-flex items-center justify-center whitespace-nowrap rounded-none border-0 bg-transparent text-sm font-bold text-[var(--color-ink)] transition-[background-color,color,transform] hover:bg-[var(--color-paper)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-[var(--color-ink)] data-[state=on]:text-[var(--color-surface)]",
  {
    variants: {
      variant: {
        default: "hover:bg-[var(--color-paper)]",
        outline:
          "bg-[var(--color-paper)] hover:bg-[var(--color-accent)] hover:text-[var(--color-surface)] data-[state=on]:bg-[var(--color-accent)] data-[state=on]:text-[var(--color-surface)]",
      },
      size: {
        default: "h-10 px-3",
        sm: "h-9 px-2.5 text-xs",
        lg: "h-11 px-5 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ToggleGroupStyleProps = VariantProps<typeof toggleGroupItemVariants>

const ToggleGroupContext = React.createContext<ToggleGroupStyleProps>({})

type ToggleGroupProps = React.ComponentPropsWithoutRef<
  typeof ToggleGroupPrimitive.Root
> &
  ToggleGroupStyleProps

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  ToggleGroupProps
>(
  (
    {
      className,
      variant = "default",
      size = "default",
      orientation = "horizontal",
      children,
      ...props
    },
    ref
  ) => (
    <ToggleGroupPrimitive.Root
      ref={ref}
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        toggleGroupVariants({ orientation }),
        orientation === "horizontal"
          ? "[&>*+*]:border-l [&>*+*]:border-l-[var(--color-ink)]"
          : "[&>*+*]:border-t [&>*+*]:border-t-[var(--color-ink)]",
        className
      )}
      orientation={orientation}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
)
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

type ToggleGroupItemProps = React.ComponentPropsWithoutRef<
  typeof ToggleGroupPrimitive.Item
> &
  ToggleGroupStyleProps

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  ToggleGroupItemProps
>(({ className, variant, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-slot="toggle-group-item"
      className={cn(
        toggleGroupItemVariants({
          variant: variant ?? context.variant,
          size: size ?? context.size,
        }),
        className
      )}
      {...props}
    />
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export {
  ToggleGroup,
  ToggleGroupItem,
  toggleGroupItemVariants,
  toggleGroupVariants,
}
export type { ToggleGroupItemProps, ToggleGroupProps }
