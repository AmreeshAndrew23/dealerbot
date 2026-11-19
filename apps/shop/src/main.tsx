import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ApiError } from "./api";
import "./styles.css";
import "./screens.css";
import "./web.css";

// Signed out elsewhere (a dealer issued a new code or removed access): any 401 re-checks the
// sign-in, which shows the sign-in screen or drops that dealer from the list.
const onError = (err: unknown, key?: readonly unknown[]) => {
  if (err instanceof ApiError && (err.status === 401 || err.status === 404) && key?.[0] !== "me") void queryClient.invalidateQueries({ queryKey: ["me"] });
};
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => onError(err, query.queryKey) }),
  mutationCache: new MutationCache({ onError: (err) => onError(err) }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
