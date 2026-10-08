"use client";

import * as React from "react";

import { cn } from "../../lib/utils.js";
import {
  nativeSelectContainerClassName,
  nativeSelectIconClassName,
  nativeSelectIconSvgClassName,
  nativeSelectOptGroupClassName,
  nativeSelectOptionClassName,
  nativeSelectVariants,
} from "../../lib/native-select.js";

export interface NativeSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "default" | "sm" | number;
  variantSize?: "default" | "sm";
  containerClassName?: string;
}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  (
    {
      className,
      containerClassName,
      size,
      variantSize,
      multiple,
      children,
      ...props
    },
    ref
  ) => {
    const isNumeric =
      typeof size === "number" || (typeof size === "string" && /^\d+$/.test(size));
    const numericSize = isNumeric ? Number(size) : undefined;
    const visualSize: "default" | "sm" =
      variantSize ?? (size === "sm" || size === "default" ? size : "default");
    const isListBox =
      Boolean(multiple) || (typeof numericSize === "number" && numericSize > 1);

    return (
      <div
        className={cn(nativeSelectContainerClassName, containerClassName)}
        data-slot="native-select-container"
      >
        <select
          ref={ref}
          size={numericSize}
          multiple={multiple}
          data-slot="native-select"
          data-size={visualSize}
          className={cn(
            nativeSelectVariants({ size: visualSize, isListBox }),
            className
          )}
          {...props}
        >
          {children}
        </select>
        {!isListBox && (
          <span aria-hidden="true" data-slot="native-select-icon" className={nativeSelectIconClassName}>
            <svg
              aria-hidden="true"
              focusable="false"
              className={nativeSelectIconSvgClassName}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        )}
      </div>
    );
  }
);
NativeSelect.displayName = "NativeSelect";

export interface NativeSelectOptionProps
  extends React.OptionHTMLAttributes<HTMLOptionElement> {}

const NativeSelectOption = React.forwardRef<
  HTMLOptionElement,
  NativeSelectOptionProps
>(({ className, ...props }, ref) => (
  <option
    ref={ref}
    data-slot="native-select-option"
    className={cn(nativeSelectOptionClassName, className)}
    {...props}
  />
));
NativeSelectOption.displayName = "NativeSelectOption";

export interface NativeSelectOptGroupProps
  extends React.OptgroupHTMLAttributes<HTMLOptGroupElement> {}

const NativeSelectOptGroup = React.forwardRef<
  HTMLOptGroupElement,
  NativeSelectOptGroupProps
>(({ className, ...props }, ref) => (
  <optgroup
    ref={ref}
    data-slot="native-select-optgroup"
    className={cn(nativeSelectOptGroupClassName, className)}
    {...props}
  />
));
NativeSelectOptGroup.displayName = "NativeSelectOptGroup";

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
