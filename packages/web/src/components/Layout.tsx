import { useEffect, useState, type ReactNode } from "react";
import { Menu, Search, X } from "lucide-react";
import CommandPalette from "./CommandPalette";
import Sidebar from "./Sidebar";
import Logo from "./Logo";
import DeployNotice from "./DeployNotice";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAppHeight } from "../hooks/useAppHeight";

export default function Layout({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useAppHeight();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const openPalette = () => { setDrawerOpen(false); setPaletteOpen(true); };

  return (
    <div className="flex h-[var(--app-height,100dvh)] bg-surface text-text-primary relative">
      <DeployNotice />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Mobile top bar */}
      {isMobile && (
        <header
          className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2 px-3 bg-surface-alt border-b border-border"
          style={{ paddingTop: 'var(--safe-top)', height: 'calc(3rem + var(--safe-top))' }}
        >
          <button
            onClick={() => setDrawerOpen(!drawerOpen)}
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            className="p-2 rounded-md text-text-secondary bg-transparent border-none cursor-pointer"
          >
            {drawerOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="flex items-center gap-2 text-text-primary">
            <Logo size={18} />
            <span className="text-[15px] font-semibold">Chomp</span>
          </div>
          <button
            onClick={openPalette}
            aria-label="Search"
            className="ml-auto p-2 rounded-md text-text-secondary bg-transparent border-none cursor-pointer"
          >
            <Search size={20} />
          </button>
        </header>
      )}

      {/* Backdrop for mobile drawer */}
      {isMobile && drawerOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar: static on desktop, overlay drawer on mobile */}
      {isMobile ? (
        <div
          className={`fixed inset-y-0 left-0 z-30 transition-transform duration-300 ease-out ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          style={{ paddingTop: 'calc(3rem + var(--safe-top))' }}
        >
          <Sidebar onNavigate={() => setDrawerOpen(false)} onSearch={openPalette} />
        </div>
      ) : (
        <Sidebar onSearch={openPalette} />
      )}

      <main
        className="flex-1 overflow-auto relative z-1"
        style={isMobile ? { paddingTop: 'calc(3rem + var(--safe-top))' } : undefined}
      >
        {children}
      </main>
    </div>
  );
}
