/** Small shadcn-style primitives on Base UI, tuned to the ElevenLabs look. */
import { Slider as BaseSlider } from "@base-ui/react/slider"
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import { clsx, type ClassValue } from "clsx"
import { Liquid } from "liquid-gooey"
import { Arc } from "loading-dev"
import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"
import { twMerge } from "tailwind-merge"
import { play } from "../sounds"

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger"
  size?: "sm" | "md" | "icon"
}

/** Button styling, also for links that look like buttons (a <button> inside an <a> is two tab stops). */
export function buttonClass(variant: NonNullable<ButtonProps["variant"]> = "outline", size: NonNullable<ButtonProps["size"]> = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
    size === "sm" && "h-7 px-3",
    size === "md" && "h-8 px-3.5",
    size === "icon" && "size-8",
    variant === "primary" && "bg-primary text-primary-foreground hover:opacity-90",
    variant === "outline" && "border border-border-strong hover:bg-hover",
    variant === "ghost" && "text-muted-foreground hover:bg-hover hover:text-foreground",
    variant === "danger" && "border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10",
    className,
  )
}

export function Button({ variant = "outline", size = "md", className, ...props }: ButtonProps) {
  return <button className={buttonClass(variant, size, className)} {...props} />
}

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border border-border-strong px-2 text-[11px] font-medium text-muted-foreground",
        tone,
        className,
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-lg border border-border-strong bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-foreground/40 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border bg-card", className)} {...props} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong px-1 font-sans text-[11px] text-muted-foreground">{children}</kbd>
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(v) => {
        play(v ? "toggleOn" : "toggleOff")
        onChange(v)
      }}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-active p-0.5 transition-colors data-[checked]:bg-primary"
    >
      <BaseSwitch.Thumb className="size-4 rounded-full bg-foreground shadow transition-transform data-[checked]:translate-x-4 data-[checked]:bg-primary-foreground" />
    </BaseSwitch.Root>
  )
}

export function Slider({ value, onChange, min = 0, max = 1, step = 0.05, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string }) {
  return (
    <BaseSlider.Root value={value} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} min={min} max={max} step={step} className="w-full">
      <BaseSlider.Control className="flex h-5 w-full touch-none items-center">
        <BaseSlider.Track className="relative h-1 w-full rounded-full bg-active">
          <BaseSlider.Indicator className="rounded-full bg-foreground" />
          <BaseSlider.Thumb aria-label={label} className="size-3.5 rounded-full border border-border-strong bg-foreground shadow focus-visible:outline-2" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}

/** Loading indicator from loading-dev; inherits the text color. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Arc size={size} className={className} />
}

/**
 * Segmented control. The selection is a liquid-gooey blob that stretches
 * and snaps to the chosen option instead of jumping.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  className?: string
  label?: string
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ x: number; w: number }>()
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current.get(value)
      if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    refs.current.forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [value, options.length])
  return (
    <div className={cn("relative isolate inline-flex h-8 items-center rounded-full border border-border-strong p-0.5", className)} role="tablist" aria-label={label}>
      {thumb && (
        // liquid-gooey styles its root position: relative inline, so it needs a positioned box to fill.
        <div className="pointer-events-none absolute inset-0">
          <Liquid fill="var(--liquid)" blur={5} contrast={16} style={{ width: "100%", height: "100%" }}>
            <Liquid.Item effect="move" move={{ springiness: 0.45, trail: 0.5 }}>
              <div
                className="absolute top-0.5 h-[calc(100%-4px)] rounded-full transition-[transform,width] duration-300 ease-[cubic-bezier(.3,1.4,.5,1)]"
                style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
              />
            </Liquid.Item>
          </Liquid>
        </div>
      )}
      {options.map((o) => (
        <button
          key={o.value}
          ref={(el) => {
            if (el) refs.current.set(o.value, el)
            else refs.current.delete(o.value)
          }}
          role="tab"
          title={o.title}
          aria-label={o.title}
          aria-selected={o.value === value}
          onClick={() => {
            if (o.value !== value) play("tick")
            onChange(o.value)
          }}
          className={cn(
            "relative z-10 flex h-full items-center rounded-full px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5",
            o.value === value && "text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[28px] font-light tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
      {icon && <div className="mb-3 text-muted-foreground [&_svg]:size-6">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}
