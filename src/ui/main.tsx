import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TooltipProvider } from "@/components/ui/tooltip"
import { App } from "./App"
import "./styles.css"
import { initTheme } from "./theme"

initTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delay={300}>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
