import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** shadcn's class merger; the dashboard's own primitives re-export the same thing from ui/components/ui. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
