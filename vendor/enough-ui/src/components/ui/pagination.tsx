"use client";

import { presentation } from '../../lib/presentation.js';

import { paginationLinkVariants } from '../../lib/variants.js';

import * as React from "react"
import { directionIconClass, directionChevronPaths } from "../../lib/direction-icons.js"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"



const Pagination = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<"nav">
>(({ className, "aria-label": ariaLabel = "Pagination", ...props }, ref) => (
  <nav
    ref={ref}
    aria-label={ariaLabel}
    data-slot="pagination"
    className={cn(presentation.Pagination, className)}
    {...props}
  />
))
Pagination.displayName = "Pagination"

const PaginationContent = React.forwardRef<
  HTMLUListElement,
  React.ComponentPropsWithoutRef<"ul">
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-slot="pagination-content"
    className={cn(
      presentation.PaginationContent,
      className
    )}
    {...props}
  />
))
PaginationContent.displayName = "PaginationContent"

const PaginationItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentPropsWithoutRef<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-slot="pagination-item"
    className={cn(presentation.PaginationItem, className)}
    {...props}
  />
))
PaginationItem.displayName = "PaginationItem"

interface PaginationLinkProps
  extends React.ComponentPropsWithoutRef<"a">,
    VariantProps<typeof paginationLinkVariants> {
  asChild?: boolean
  disabled?: boolean
  isActive?: boolean
}

const PaginationLink = React.forwardRef<HTMLAnchorElement, PaginationLinkProps>(
  (
    {
      asChild = false,
      "aria-disabled": ariaDisabled,
      children,
      className,
      disabled = false,
      isActive = false,
      href,
      onClick,
      size,
      tabIndex,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "a"
    const isDisabled = disabled || ariaDisabled === true || ariaDisabled === "true"
    const content = asChild && isDisabled && React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<React.ComponentPropsWithoutRef<"a">>, {
          href: undefined,
          "aria-disabled": true,
          tabIndex: -1,
          onClick: (event) => event.preventDefault(),
        })
      : children

    return (
      <Comp
        ref={ref}
        aria-current={isActive ? "page" : undefined}
        aria-disabled={isDisabled || undefined}
        data-active={isActive ? "true" : undefined}
        data-disabled={isDisabled ? "true" : undefined}
        data-slot="pagination-link"
        href={isDisabled ? undefined : href}
        tabIndex={isDisabled ? -1 : tabIndex}
        onClick={(event) => {
          if (isDisabled) {
            event.preventDefault()
            return
          }
          onClick?.(event)
        }}
        className={cn(
          paginationLinkVariants({
            variant: isActive ? "active" : "default",
            size,
          }),
          className
        )}
        {...props}
      >
        {content}
      </Comp>
    )
  }
)
PaginationLink.displayName = "PaginationLink"

const PaginationPrevious = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<typeof PaginationLink> & { text?: string }
>(({ className, children, text = "Previous", ...props }, ref) => (
  <PaginationLink
    ref={ref}
    aria-label="Go to previous page"
    size="default"
    className={cn(presentation.PaginationPrevious, className)}
    {...props}
  >
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn(directionIconClass, "rtl:rotate-180")}>
      <path d={directionChevronPaths.left} />
    </svg>
    <span className="max-[479px]:sr-only">{children ?? text}</span>
  </PaginationLink>
))
PaginationPrevious.displayName = "PaginationPrevious"

const PaginationNext = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<typeof PaginationLink> & { text?: string }
>(({ className, children, text = "Next", ...props }, ref) => (
  <PaginationLink
    ref={ref}
    aria-label="Go to next page"
    size="default"
    className={cn(presentation.PaginationNext, className)}
    {...props}
  >
    <span className="max-[479px]:sr-only">{children ?? text}</span>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn(directionIconClass, "rtl:rotate-180")}>
      <path d={directionChevronPaths.right} />
    </svg>
  </PaginationLink>
))
PaginationNext.displayName = "PaginationNext"

const PaginationEllipsis = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    data-slot="pagination-ellipsis"
    className={cn(
      presentation.PaginationEllipsis,
      className
    )}
    {...props}
  >
    <span aria-hidden="true">…</span>
    <span className="sr-only">More pages</span>
  </span>
))
PaginationEllipsis.displayName = "PaginationEllipsis"

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationLinkVariants,
}
