import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, ScrollRestoration, Outlet } from "react-router-dom";
import "./index.css";

const HomePage = lazy(() => import("@/site/HomePage"));
const ChangelogPage = lazy(() => import("@/pages/ChangelogPage"));

function Shell() {
  return (
    <>
      <ScrollRestoration />
      <Suspense fallback={<div className="min-h-[100dvh] bg-canvas" />}>
        <Outlet />
      </Suspense>
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/changelog", element: <ChangelogPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
