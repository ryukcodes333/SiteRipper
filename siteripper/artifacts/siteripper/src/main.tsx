import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import App from "./App";
import "./index.css";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function nav(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

createRoot(document.getElementById("root")!).render(
  <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    signInFallbackRedirectUrl={basePath + "/dashboard"}
    signUpFallbackRedirectUrl={basePath + "/dashboard"}
    signInForceRedirectUrl={basePath + "/dashboard"}
    signUpForceRedirectUrl={basePath + "/dashboard"}
    routerPush={(to) => nav(to)}
    routerReplace={(to) => {
      window.history.replaceState(null, "", to);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }}
    appearance={{
      baseTheme: dark,
      variables: {
        colorPrimary: "#4f83ff",
        colorBackground: "#0f0f11",
        colorInputBackground: "#1a1a1e",
        colorNeutral: "#ffffff",
        borderRadius: "10px",
      },
      elements: {
        headerTitle: { display: "none" },
        headerSubtitle: { display: "none" },
        card: {
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 0 40px rgba(79,131,255,0.08)",
        },
      },
    }}
  >
    <App basePath={basePath} />
  </ClerkProvider>,
);
