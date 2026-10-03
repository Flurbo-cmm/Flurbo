import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/cormorant-garamond/latin-500-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles.css";
import App from "./App";
import { AuthProvider } from "./auth/context";
import LoaderHost from "./loading/LoaderHost";
import { prefetchAccess } from "./prefetch";

// Start the access check now, alongside the sign-in check, instead of after it.
prefetchAccess(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <LoaderHost><App /></LoaderHost>
      </AuthProvider>
    </MotionConfig>
  </StrictMode>,
);
