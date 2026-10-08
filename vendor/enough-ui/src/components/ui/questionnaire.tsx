"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire"

import { cn } from "../../lib/utils.js"
import { buttonVariants, type ButtonProps } from "./button.js"

const LegacyQuestionnaire = React.forwardRef<
  HTMLFormElement,
  React.FormHTMLAttributes<HTMLFormElement>
>(({ className, ...props }, ref) => (
  <form
    ref={ref}
    data-slot="questionnaire"
    className={cn(
      "w-full rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-card)]",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaire.displayName = "LegacyQuestionnaire"

const LegacyQuestionnaireHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="questionnaire-header"
    className={cn(
      "flex flex-col gap-3 rounded-none border-b border-[var(--color-ink)] p-5 sm:p-6",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireHeader.displayName = "LegacyQuestionnaireHeader"

const LegacyQuestionnaireEyebrow = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="questionnaire-eyebrow"
    className={cn(
      "font-sans text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-3)]",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireEyebrow.displayName = "LegacyQuestionnaireEyebrow"

const LegacyQuestionnaireTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    data-slot="questionnaire-title"
    className={cn(
      "font-serif text-2xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ink)] sm:text-3xl",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireTitle.displayName = "LegacyQuestionnaireTitle"

const LegacyQuestionnaireDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="questionnaire-description"
    className={cn(
      "max-w-prose font-sans text-sm leading-6 text-[var(--color-text-3)]",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireDescription.displayName = "LegacyQuestionnaireDescription"

type LegacyQuestionnaireProgressProps = Omit<
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
  "value" | "max"
> & {
  value: number
  max?: number
  label?: string
}

const LegacyQuestionnaireProgress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  LegacyQuestionnaireProgressProps
>(({ className, value, max = 100, label = "LegacyQuestionnaire progress", ...props }, ref) => {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100
  const safeValue = Number.isFinite(value)
    ? Math.min(Math.max(value, 0), safeMax)
    : 0
  const percentage = (safeValue / safeMax) * 100

  return (
    <ProgressPrimitive.Root
      ref={ref}
      data-slot="questionnaire-progress"
      value={safeValue}
      max={safeMax}
      aria-label={label}
      className={cn(
        "relative h-3 w-full overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-paper)]",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="questionnaire-progress-indicator"
        className="h-full w-full rounded-none bg-[var(--color-accent)] transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - percentage}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
LegacyQuestionnaireProgress.displayName = ProgressPrimitive.Root.displayName

const LegacyQuestionnaireContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="questionnaire-content"
    className={cn("flex flex-col gap-7 p-5 sm:p-6", className)}
    {...props}
  />
))
LegacyQuestionnaireContent.displayName = "LegacyQuestionnaireContent"

const LegacyQuestionnaireItem = React.forwardRef<
  HTMLFieldSetElement,
  React.FieldsetHTMLAttributes<HTMLFieldSetElement>
>(({ className, ...props }, ref) => (
  <fieldset
    ref={ref}
    data-slot="questionnaire-item"
    className={cn(
      "min-w-0 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-palette)] disabled:opacity-50 sm:p-5",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireItem.displayName = "LegacyQuestionnaireItem"

const LegacyQuestionnaireItemLabel = React.forwardRef<
  HTMLLegendElement,
  React.HTMLAttributes<HTMLLegendElement>
>(({ className, ...props }, ref) => (
  <legend
    ref={ref}
    data-slot="questionnaire-item-label"
    className={cn(
      "max-w-[calc(100%-1rem)] bg-[var(--color-surface)] px-2 font-sans text-base font-semibold leading-snug text-[var(--color-ink)]",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireItemLabel.displayName = "LegacyQuestionnaireItemLabel"

const LegacyQuestionnaireItemDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="questionnaire-item-description"
    className={cn(
      "mb-4 font-sans text-xs leading-5 text-[var(--color-text-3)]",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireItemDescription.displayName = "LegacyQuestionnaireItemDescription"

const LegacyQuestionnaireChoices = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-slot="questionnaire-choices"
    className={cn("grid gap-2", className)}
    {...props}
  />
))
LegacyQuestionnaireChoices.displayName = RadioGroupPrimitive.Root.displayName

type LegacyQuestionnaireChoiceProps = React.ComponentPropsWithoutRef<
  typeof RadioGroupPrimitive.Item
> & {
  label: React.ReactNode
  description?: React.ReactNode
}

const LegacyQuestionnaireChoice = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  LegacyQuestionnaireChoiceProps
>(({ className, id, label, description, ...props }, ref) => {
  const generatedId = React.useId()
  const choiceId = id ?? generatedId

  return (
    <LabelPrimitive.Root
      htmlFor={choiceId}
      data-slot="questionnaire-choice-label"
      className="group flex cursor-pointer items-start gap-3 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-3 transition-[background-color,transform] hover:bg-[var(--color-accent-soft)] has-[[data-state=checked]]:bg-[var(--color-accent-soft)] has-[[data-state=checked]]:shadow-[var(--shadow-card)] has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50"
    >
      <RadioGroupPrimitive.Item
        ref={ref}
        id={choiceId}
        data-slot="questionnaire-choice"
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 disabled:cursor-not-allowed",
          className
        )}
        {...props}
      >
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
          <span className="size-2.5 rounded-none bg-[var(--color-accent)]" />
        </RadioGroupPrimitive.Indicator>
      </RadioGroupPrimitive.Item>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-sans text-sm font-semibold leading-5 text-[var(--color-ink)]">
          {label}
        </span>
        {description ? (
          <span className="font-sans text-xs leading-5 text-[var(--color-text-3)]">
            {description}
          </span>
        ) : null}
      </span>
    </LabelPrimitive.Root>
  )
})
LegacyQuestionnaireChoice.displayName = RadioGroupPrimitive.Item.displayName

const LegacyQuestionnaireFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="questionnaire-footer"
    className={cn(
      "flex flex-wrap items-center justify-between gap-3 rounded-none border-t border-[var(--color-ink)] bg-[var(--color-paper)] p-5 sm:p-6",
      className
    )}
    {...props}
  />
))
LegacyQuestionnaireFooter.displayName = "LegacyQuestionnaireFooter"

const LegacyQuestionnaireContext = React.createContext(false)

function containsLegacyItem(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) =>
    React.isValidElement<{ name?: string; children?: React.ReactNode }>(child) &&
    ((child.type === QuestionnaireItem && !child.props.name) || containsLegacyItem(child.props.children))
  )
}

function questionnaireClass(base: string, className?: string) { return cn(base, className) }

type QuestionnaireProps = React.ComponentProps<typeof QuestionnairePrimitive.Root> & { legacy?: boolean }

function Questionnaire({ className, legacy, ...props }: QuestionnaireProps) {
  const isLegacy = legacy ?? (!props.items && !props.item && !props.defaultItem && containsLegacyItem(props.children))
  return (
    <LegacyQuestionnaireContext.Provider value={isLegacy}>
      {isLegacy
        ? <LegacyQuestionnaire className={className} {...props} />
        : <QuestionnairePrimitive.Root data-slot="questionnaire" className={cn("flex w-full min-w-0 flex-col gap-6 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-5 font-sans text-[var(--color-ink)] shadow-[var(--shadow-card)] sm:p-6", className)} {...props} />}
    </LegacyQuestionnaireContext.Provider>
  )
}

type QuestionnaireProgressProps = React.ComponentProps<typeof QuestionnairePrimitive.Progress> & {
  /** Compatibility with EnoughUI's original numeric progress bar. */
  value?: number
  max?: number
  label?: string
}

function QuestionnaireProgress({ className, value, max, label, ...props }: QuestionnaireProgressProps) {
  if (value !== undefined) return <LegacyQuestionnaireProgress value={value} max={max} label={label} className={className} {...props as Omit<React.ComponentProps<typeof LegacyQuestionnaireProgress>, "value">} />
  return <QuestionnairePrimitive.Progress data-slot="questionnaire-progress" aria-label={label ?? "Questionnaire progress"} className={questionnaireClass("min-h-[1lh] w-fit min-w-[14ch] font-sans text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-3)]", className)} {...props} />
}

type QuestionnaireItemProps = Omit<React.ComponentProps<typeof QuestionnairePrimitive.Item>, "name"> & { name?: string }

function QuestionnaireItem({ className, name, ...props }: QuestionnaireItemProps) {
  const legacy = React.useContext(LegacyQuestionnaireContext)
  if (legacy) return <LegacyQuestionnaireItem className={className} {...props as React.ComponentProps<typeof LegacyQuestionnaireItem>} />
  if (!name) throw new Error("QuestionnaireItem requires a unique name in a multi-step Questionnaire.")
  return <QuestionnairePrimitive.Item data-slot="questionnaire-item" name={name} className={cn("min-w-0 border-0 p-0 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]", className)} {...props} />
}

function QuestionnaireTitle({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Title>) {
  const legacy = React.useContext(LegacyQuestionnaireContext)
  if (legacy) return <LegacyQuestionnaireTitle className={className} {...props as React.ComponentProps<typeof LegacyQuestionnaireTitle>} />
  return <QuestionnairePrimitive.Title data-slot="questionnaire-title" className={cn("mb-3 w-full font-serif text-2xl font-semibold leading-tight tracking-[-0.02em] text-pretty text-[var(--color-ink)] sm:text-3xl", className)} {...props} />
}

function QuestionnaireDescription({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Description>) {
  const legacy = React.useContext(LegacyQuestionnaireContext)
  if (legacy) return <LegacyQuestionnaireDescription className={className} {...props as React.ComponentProps<typeof LegacyQuestionnaireDescription>} />
  return <QuestionnairePrimitive.Description data-slot="questionnaire-description" className={cn("mb-5 max-w-prose font-sans text-sm leading-6 text-pretty text-[var(--color-text-3)]", className)} {...props} />
}

type QuestionnaireChoicesProps = React.ComponentProps<typeof QuestionnairePrimitive.Choices> & Pick<React.ComponentProps<typeof RadioGroupPrimitive.Root>, "name" | "value" | "defaultValue" | "onValueChange" | "required" | "disabled" | "orientation" | "loop">

function QuestionnaireChoices({ className, name, value, defaultValue, onValueChange, required, disabled, orientation, loop, ...props }: QuestionnaireChoicesProps) {
  const legacy = React.useContext(LegacyQuestionnaireContext)
  if (legacy) return <LegacyQuestionnaireChoices name={name} value={value} defaultValue={defaultValue} onValueChange={onValueChange} required={required} disabled={disabled} orientation={orientation} loop={loop} className={className} {...props as React.ComponentProps<typeof LegacyQuestionnaireChoices>} />
  return <QuestionnairePrimitive.Choices data-slot="questionnaire-choices" className={cn("group/questionnaire-choices grid min-w-0 gap-2", className)} {...props} />
}

type QuestionnaireChoiceProps = React.ComponentProps<typeof QuestionnairePrimitive.Choice> & {
  /** The legacy label prop is equivalent to children. */
  label?: React.ReactNode
  description?: React.ReactNode
}

function QuestionnaireChoice({ className, children, label, description, ...props }: QuestionnaireChoiceProps) {
  const legacy = React.useContext(LegacyQuestionnaireContext)
  if (legacy) return <LegacyQuestionnaireChoice {...props as React.ComponentProps<typeof LegacyQuestionnaireChoice>} label={label ?? children} description={description} className={typeof className === "string" ? className : undefined} />
  return (
    <QuestionnairePrimitive.Choice
      data-slot="questionnaire-choice"
      className={questionnaireClass("group/questionnaire-choice relative flex min-h-11 cursor-pointer select-none items-start gap-3 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] p-3 text-start transition-colors outline-none hover:bg-[var(--color-accent-soft)] data-[checked]:bg-[var(--color-accent-soft)] data-[checked]:shadow-[var(--shadow-card)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-accent)] has-[:focus-visible]:ring-offset-2 data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[invalid]:border-[var(--color-warn)]", className)}
      {...props}
    >
      <QuestionnairePrimitive.ChoiceInput data-slot="questionnaire-choice-input" className="absolute inset-0 z-10 size-full cursor-pointer opacity-0" />
      <span aria-hidden="true" data-slot="questionnaire-choice-indicator" className="pointer-events-none mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)]">
        <span className="hidden size-2.5 bg-[var(--color-accent)] group-data-[checked]/questionnaire-choice:block group-data-[type=checkbox]/questionnaire-choice:hidden" />
        <span className="hidden text-sm text-[var(--color-accent)] group-data-[checked]/questionnaire-choice:block group-data-[type=radio]/questionnaire-choice:hidden">✓</span>
      </span>
      <QuestionnairePrimitive.ChoiceLabel data-slot="questionnaire-choice-label" className="flex min-w-0 flex-1 flex-col gap-1 font-sans text-sm font-semibold leading-5 text-[var(--color-ink)]">
        {label ?? children}
        {description && <QuestionnaireChoiceDescription>{description}</QuestionnaireChoiceDescription>}
      </QuestionnairePrimitive.ChoiceLabel>
      <QuestionnairePrimitive.ChoiceShortcut data-slot="questionnaire-choice-shortcut" className="pointer-events-none ms-auto hidden size-6 shrink-0 items-center justify-center border border-[var(--color-ink)] font-sans text-xs text-[var(--color-text-3)] group-data-[shortcut]/questionnaire-choice:inline-flex" />
    </QuestionnairePrimitive.Choice>
  )
}

function QuestionnaireChoiceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="questionnaire-choice-description" className={cn("font-sans text-xs font-normal leading-5 text-[var(--color-text-3)]", className)} {...props} />
}

function QuestionnaireInput({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Input>) {
  return <div data-slot="questionnaire-input-wrapper" className="relative min-w-0"><QuestionnairePrimitive.Input data-slot="questionnaire-input" className={questionnaireClass("min-h-11 w-full min-w-0 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-3 py-2.5 font-sans text-[15px] text-[var(--color-ink)] shadow-[var(--shadow-card)] outline-none placeholder:text-[var(--color-text-4)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] data-[invalid]:border-[var(--color-warn)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} /></div>
}

function QuestionnaireError({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Error>) {
  return <QuestionnairePrimitive.Error data-slot="questionnaire-error" className={questionnaireClass("mt-3 font-sans text-sm text-[var(--color-warn)]", className)} {...props} />
}

function QuestionnaireActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="questionnaire-actions" className={cn("grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-t border-[var(--color-ink)] pt-5", className)} {...props} />
}

type QuestionnaireActionAppearance = {
  size?: ButtonProps["size"] | "default" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
  variant?: ButtonProps["variant"] | "default" | "secondary" | "link"
}

function actionClass(size: QuestionnaireActionAppearance["size"], variant: QuestionnaireActionAppearance["variant"], position: string) {
  const localSize = size === "default" || size === "lg" || size?.startsWith("icon") ? "md" : size
  const localVariant = variant === "default" ? "ink" : variant === "secondary" ? "outline" : variant === "link" ? "ghost" : variant
  return cn(buttonVariants({ size: localSize as ButtonProps["size"], variant: localVariant }), "min-h-11", position, size?.startsWith("icon") && "size-11 px-0")
}

function QuestionnairePrevious({ children, className, size = "default", variant = "outline", ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Previous> & QuestionnaireActionAppearance) {
  return <QuestionnairePrimitive.Previous data-slot="questionnaire-previous" data-size={size} data-variant={variant} className={questionnaireClass(actionClass(size, variant, "col-start-1 row-start-1 justify-self-start"), className)} {...props}>{children ?? "Previous"}</QuestionnairePrimitive.Previous>
}

function QuestionnaireSkip({ children, className, size = "default", variant = "outline", ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Skip> & QuestionnaireActionAppearance) {
  return <QuestionnairePrimitive.Skip data-slot="questionnaire-skip" data-size={size} data-variant={variant} className={questionnaireClass(actionClass(size, variant, "col-start-2 row-start-1 justify-self-end"), className)} {...props}>{children ?? "Skip"}</QuestionnairePrimitive.Skip>
}

function QuestionnaireNext({ children, className, size = "default", variant = "default", ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Next> & QuestionnaireActionAppearance) {
  return <QuestionnairePrimitive.Next data-slot="questionnaire-next" data-size={size} data-variant={variant} className={questionnaireClass(actionClass(size, variant, "col-start-3 row-start-1 justify-self-end"), className)} {...props}>{children ?? "Next"}</QuestionnairePrimitive.Next>
}

function QuestionnaireSubmit({ children, className, size = "default", variant = "default", ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Submit> & QuestionnaireActionAppearance) {
  return <QuestionnairePrimitive.Submit data-slot="questionnaire-submit" data-size={size} data-variant={variant} className={questionnaireClass(actionClass(size, variant, "col-start-3 row-start-1 justify-self-end"), className)} {...props}>{children ?? "Submit"}</QuestionnairePrimitive.Submit>
}

const QuestionnaireHeader = LegacyQuestionnaireHeader
const QuestionnaireEyebrow = LegacyQuestionnaireEyebrow
const QuestionnaireContent = LegacyQuestionnaireContent
const QuestionnaireFooter = LegacyQuestionnaireFooter
const QuestionnaireItemLabel = LegacyQuestionnaireItemLabel
const QuestionnaireItemDescription = LegacyQuestionnaireItemDescription

export {
  Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription,
  QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireInput,
  QuestionnaireItem, QuestionnaireNext, QuestionnairePrevious, QuestionnaireProgress,
  QuestionnaireSkip, QuestionnaireSubmit, QuestionnaireTitle,
  QuestionnaireHeader, QuestionnaireEyebrow, QuestionnaireContent, QuestionnaireFooter,
  QuestionnaireItemLabel, QuestionnaireItemDescription,
}
export type { QuestionnaireProps, QuestionnaireChoiceProps, QuestionnaireProgressProps, QuestionnaireItemProps }
