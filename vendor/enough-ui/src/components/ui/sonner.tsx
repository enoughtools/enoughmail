"use client";

import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { cn } from "../../lib/utils.js"

function StatusIcon({ type }: { type: "success" | "info" | "warning" | "error" | "loading" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={type === "loading" ? "animate-spin motion-reduce:animate-none" : undefined}>
      {type === "loading" ? <path d="M20 12a8 8 0 1 1-8-8" /> : type === "warning" ? <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v4m0 4h.01" /></> : <><circle cx="12" cy="12" r="9" />{type === "success" ? <path d="m8 12 3 3 5-6" /> : type === "error" ? <path d="m9 9 6 6m0-6-6 6" /> : <path d="M12 11v6m0-10h.01" />}</>}
    </svg>
  )
}

const toasterStyle = {
  fontFamily: "var(--font-sans)",
  "--normal-bg": "var(--color-surface)",
  "--normal-text": "var(--color-ink)",
  "--normal-border": "var(--color-border-mid)",
  "--success-bg": "var(--color-surface)",
  "--success-text": "var(--color-ink)",
  "--success-border": "var(--color-accent)",
  "--info-bg": "var(--color-surface)",
  "--info-text": "var(--color-ink)",
  "--info-border": "var(--color-accent)",
  "--warning-bg": "var(--color-surface)",
  "--warning-text": "var(--color-warn)",
  "--warning-border": "var(--color-warn)",
  "--error-bg": "var(--color-surface)",
  "--error-text": "var(--color-warn)",
  "--error-border": "var(--color-warn)",
  "--border-radius": "0px",
} as React.CSSProperties

function Toaster({ theme = "system", className, style, icons, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      {...props}
      theme={theme}
      className={cn("toaster group font-sans", className)}
      style={{ ...toasterStyle, ...style }}
      icons={{
        success: <StatusIcon type="success" />,
        info: <StatusIcon type="info" />,
        warning: <StatusIcon type="warning" />,
        error: <StatusIcon type="error" />,
        loading: <StatusIcon type="loading" />,
        ...icons,
      }}
      toastOptions={{
        ...toastOptions,
        style: { fontFamily: "var(--font-sans)", borderRadius: 0, boxShadow: "var(--shadow-palette)", ...toastOptions?.style },
        actionButtonStyle: { fontFamily: "var(--font-sans)", borderRadius: 0, ...toastOptions?.actionButtonStyle },
        cancelButtonStyle: { fontFamily: "var(--font-sans)", borderRadius: 0, ...toastOptions?.cancelButtonStyle },
        classNames: {
          ...toastOptions?.classNames,
          toast: cn("font-sans rounded-none", toastOptions?.classNames?.toast),
          title: cn("font-semibold", toastOptions?.classNames?.title),
          description: cn("text-[var(--color-text-3)]", toastOptions?.classNames?.description),
          actionButton: cn("font-sans rounded-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]", toastOptions?.classNames?.actionButton),
          cancelButton: cn("font-sans rounded-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]", toastOptions?.classNames?.cancelButton),
          closeButton: cn("rounded-none! focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]", toastOptions?.classNames?.closeButton),
        },
      }}
    />
  )
}

const SonnerToaster = Toaster

export { Toaster, SonnerToaster, type ToasterProps }
export { toast } from "sonner"
