import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { useAuth } from "./hooks/useAuth";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import Skills from "./pages/Skills";
import McpServers from "./pages/McpServers";
import Plugins from "./pages/Plugins";

import Memories from "./pages/Memories";
import Schedules from "./pages/Schedules";
import Dashboard from "./pages/Dashboard";
import Dashboards from "./pages/Dashboards";
import AgentMonitor from "./pages/AgentMonitor";

import Triggers from "./pages/Triggers";
import Webhooks from "./pages/Webhooks";
import ProactiveRules from "./pages/ProactiveRules";
import Settings from "./pages/Settings";
import Sites from "./pages/Sites";
import Souls from "./pages/Souls";
import Birthright from "./pages/Birthright";
import Monitoring from "./pages/Monitoring";
// Lazy: the file viewer brings its own grammars and highlighting.
const Files = lazy(() => import("./pages/Files"));
import Layout from "./components/Layout";

const GoodMorning = lazy(() => import("./pages/GoodMorning"));
const Terminal = lazy(() => import("./pages/Terminal"));

const pageVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

export default function App() {
  const { token, isLoading } = useAuth();
  const location = useLocation();

  // Opens from a Telegram link with its own key, outside the login and the app shell.
  if (location.pathname === "/goodmorning") {
    return (
      <Suspense fallback={null}>
        <GoodMorning />
      </Suspense>
    );
  }

  if (isLoading)
    return (
      <div className="flex justify-center items-center h-screen bg-surface text-text-muted font-body">
        Loading
      </div>
    );

  if (!token) return <Login />;

  // The rite happens outside the app shell: there is no sidebar in space.
  if (location.pathname === "/birthright") return <Birthright />;

  return (
    <Layout>
      <AnimatePresence mode="wait">
        <motion.div
          key={["/chat", "/terminal"].find((section) => location.pathname.startsWith(section)) ?? location.pathname}
          variants={pageVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.15, ease: "easeOut" }}
          style={{ height: "100%" }}
        >
          <Routes location={location}>
            <Route path="/" element={<Navigate to="/chat" />} />
            <Route path="/chat/:conversationId?" element={<Chat />} />
            <Route path="/agents" element={<Souls />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/mcp" element={<McpServers />} />
            <Route path="/plugins" element={<Plugins />} />

            <Route path="/memories" element={<Memories />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboards" element={<Dashboards />} />
            <Route path="/agent-monitor" element={<AgentMonitor />} />
            <Route path="/triggers" element={<Triggers />} />
            <Route path="/webhooks" element={<Webhooks />} />
            <Route path="/proactive" element={<ProactiveRules />} />
            <Route path="/activity" element={<Navigate to="/agent-monitor" />} />
            <Route path="/sites" element={<Sites />} />
            <Route path="/monitoring" element={<Monitoring />} />
            <Route path="/uptime" element={<Navigate to="/monitoring" replace />} />
            <Route path="/files" element={<Suspense fallback={null}><Files /></Suspense>} />
            <Route path="/terminal/:terminalId?" element={<Suspense fallback={null}><Terminal /></Suspense>} />
            <Route path="/souls" element={<Navigate to="/agents" replace />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </Layout>
  );
}
