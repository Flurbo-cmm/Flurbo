import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig } from "framer-motion";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/geist-pixel/latin-400.css";
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

// Animation features download after first paint; until then motion elements render their resting state.
const motionFeatures = () => import("./motion-features").then((module) => module.default);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LazyMotion features={motionFeatures}>
        <AuthProvider>
          <LoaderHost><App /></LoaderHost>
        </AuthProvider>
      </LazyMotion>
    </MotionConfig>
  </StrictMode>,
);
