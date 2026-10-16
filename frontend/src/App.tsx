import { lazy, Suspense, useState, useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout";
import { LoadingState } from "./components/common";
import { OverviewPage } from "./pages/Overview";
import { VisionProvider } from "./vision/VisionProvider";
import { api } from "./api";
import type { DashboardSummary } from "./api/types";

const DigitalTwinPage = lazy(() =>
  import("./pages/DigitalTwin").then((m) => ({ default: m.DigitalTwinPage })),
);
const IntelligencePage = lazy(() =>
  import("./pages/Intelligence").then((m) => ({ default: m.IntelligencePage })),
);
const VisionPage = lazy(() =>
  import("./pages/Vision").then((m) => ({ default: m.VisionPage })),
);

export function App() {
  const [dashData, setDashData] = useState<DashboardSummary | null>(null);

  // Load summary metrics for header and indicators
  useEffect(() => {
    api.dashboard().then(setDashData).catch(() => null);
  }, []);

  return (
    <div
      id="app-shell"
      style={{
        display: "flex",
        height: "100%",
        minHeight: "100vh",
        flexDirection: "column",
      }}
    >
      <VisionProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout dashData={dashData} />}>
                <Route index element={<OverviewPage />} />
                <Route
                  path="/twin"
                  element={
                    <Suspense fallback={<LoadingState label="Loading TalTech Real Digital Twin…" />}>
                      <DigitalTwinPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/digital-twin"
                  element={
                    <Suspense fallback={<LoadingState label="Loading TalTech Real Digital Twin…" />}>
                      <DigitalTwinPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/intelligence"
                  element={
                    <Suspense fallback={<LoadingState label="Loading Intelligence Engine…" />}>
                      <IntelligencePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/vision"
                  element={
                    <Suspense fallback={<LoadingState label="Loading Camera Occupancy…" />}>
                      <VisionPage />
                    </Suspense>
                  }
                />
                <Route path="*" element={<OverviewPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </VisionProvider>
    </div>
  );
}