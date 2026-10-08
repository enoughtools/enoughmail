"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils.js";
import {
  avatarVariants,
  avatarImageClass,
  avatarFallbackClass,
  avatarBadgeVariants,
  avatarGroupVariants,
  avatarGroupCountVariants,
  type AvatarSize,
  type AvatarBadgeVariant,
  type AvatarBadgeSize,
} from "../../lib/minor-presentation.js";

interface AvatarProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
    VariantProps<typeof avatarVariants> {}

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(({ className, size = "default", ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    data-slot="avatar"
    data-size={size}
    className={cn(avatarVariants({ size }), className)}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

interface AvatarImageProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> {}

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  AvatarImageProps
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    data-slot="avatar-image"
    className={cn(avatarImageClass, className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

interface AvatarFallbackProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> {}

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  AvatarFallbackProps
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    data-slot="avatar-fallback"
    className={cn(avatarFallbackClass, className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

interface AvatarBadgeProps
  extends React.ComponentPropsWithoutRef<"span">,
    VariantProps<typeof avatarBadgeVariants> {}

const AvatarBadge = React.forwardRef<HTMLSpanElement, AvatarBadgeProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <span
      ref={ref}
      data-slot="avatar-badge"
      className={cn(avatarBadgeVariants({ variant, size }), className)}
      {...props}
    />
  )
);
AvatarBadge.displayName = "AvatarBadge";

interface AvatarGroupProps
  extends React.ComponentPropsWithoutRef<"div">,
    VariantProps<typeof avatarGroupVariants> {}

const AvatarGroup = React.forwardRef<HTMLDivElement, AvatarGroupProps>(
  ({ className, size = "default", ...props }, ref) => (
    <div
      ref={ref}
      data-slot="avatar-group"
      className={cn(avatarGroupVariants({ size }), className)}
      {...props}
    />
  )
);
AvatarGroup.displayName = "AvatarGroup";

interface AvatarGroupCountProps
  extends React.ComponentPropsWithoutRef<"span">,
    VariantProps<typeof avatarGroupCountVariants> {}

const AvatarGroupCount = React.forwardRef<
  HTMLSpanElement,
  AvatarGroupCountProps
>(({ className, size = "default", ...props }, ref) => (
  <span
    ref={ref}
    data-slot="avatar-group-count"
    className={cn(avatarGroupCountVariants({ size }), className)}
    {...props}
  />
));
AvatarGroupCount.displayName = "AvatarGroupCount";

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
};
export type {
  AvatarProps,
  AvatarImageProps,
  AvatarFallbackProps,
  AvatarBadgeProps,
  AvatarGroupProps,
  AvatarGroupCountProps,
  AvatarSize,
  AvatarBadgeVariant,
  AvatarBadgeSize,
};
