import { NavLink } from "react-router-dom";
import { useState, type ComponentType } from "react";
import Logo from "./Logo";
import MonitoringBadge from "./monitoring/MonitoringBadge";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  LayoutGrid,
  MessageCircle,
  Settings,
  Bot,
  Activity,
  Brain,
  BookOpen,
  Clock,
  Zap,
  Webhook,
  Sparkles,
  Puzzle,
  Plug,
  Globe,
  ChevronDown,
  Flame,
  HeartPulse,
  FolderTree,
  Search,
  Terminal,
} from "lucide-react";

interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown at the right of the item, such as a count of problems. */
  Badge?: ComponentType;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

const standalone = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/dashboards", label: "Boards", icon: LayoutGrid },
  { to: "/chat", label: "Chat", icon: MessageCircle },
];

const groups: NavGroup[] = [
  {
    label: "Agents",
    items: [
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/birthright", label: "Birthright", icon: Flame },
      { to: "/agent-monitor", label: "Activity", icon: Activity },
      { to: "/memories", label: "Memories", icon: Brain },
    ],
  },
  {
    label: "Capabilities",
    items: [
      { to: "/skills", label: "Skills", icon: BookOpen },
      { to: "/plugins", label: "Plugins", icon: Puzzle },
      { to: "/mcp", label: "MCP servers", icon: Plug },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/schedules", label: "Schedules", icon: Clock },
      { to: "/triggers", label: "Triggers", icon: Zap },
      { to: "/webhooks", label: "Webhooks", icon: Webhook },
      { to: "/proactive", label: "Proactive", icon: Sparkles },
    ],
  },
  {
    label: "Server",
    items: [
      { to: "/monitoring", label: "Monitoring", icon: HeartPulse, Badge: MonitoringBadge },
      { to: "/sites", label: "Sites", icon: Globe },
      { to: "/files", label: "Files", icon: FolderTree },
      { to: "/terminal", label: "Terminal", icon: Terminal },
    ],
  },
];

/** Every page the menu links to, flat, for the command palette. */
export const navItems = [
  ...standalone,
  ...groups.flatMap((g) => g.items),
  { to: "/settings", label: "Settings", icon: Settings },
];

function NavItem({ to, label, icon: Icon, Badge, onNavigate }: NavEntry & { onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-2.5 h-8 px-2 rounded-md text-sm no-underline transition-colors duration-150 ${
          isActive
            ? "bg-raised text-text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] [&_svg]:text-text-secondary"
            : "text-text-secondary hover:bg-white/4 hover:text-text-primary"
        }`
      }
    >
      <Icon size={16} strokeWidth={1.5} className="shrink-0 text-text-muted" />
      {label}
      {Badge && <Badge />}
    </NavLink>
  );
}

function GroupSection({ group, onNavigate }: { group: NavGroup; onNavigate?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="group flex items-center justify-between w-full h-6 px-2 mt-6 mb-1 bg-transparent border-none text-xs text-text-muted cursor-pointer hover:text-text-secondary"
      >
        {group.label}
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={`opacity-0 group-hover:opacity-100 transition-[transform,opacity] duration-150 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {group.items.map((item) => (
            <NavItem key={item.to} {...item} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch?: () => void } = {}) {
  return (
    <nav className="w-60 h-full px-3 py-4 flex flex-col bg-surface-alt border-r border-border overflow-y-auto overscroll-contain">
      <div className="flex items-center gap-2.5 h-8 px-2 mb-4 text-text-primary">
        <Logo />
        <span className="text-base font-semibold">Chomp</span>
      </div>

      {onSearch && (
        <button
          type="button"
          onClick={onSearch}
          className="flex items-center gap-2.5 h-8 px-2 mb-2 rounded-md bg-raised/60 border border-border text-sm text-text-muted cursor-pointer transition-colors hover:text-text-secondary hover:border-white/14"
        >
          <Search size={15} strokeWidth={1.5} className="shrink-0" />
          Search
          <kbd className="ml-auto font-sans text-[11px] text-text-muted">{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      )}

      <div className="flex flex-col gap-0.5">
        {standalone.map((item) => (
          <NavItem key={item.to} {...item} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="flex flex-col flex-1">
        {groups.map((group) => (
          <GroupSection key={group.label} group={group} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="border-t border-border pt-3 mt-6">
        <NavItem to="/settings" label="Settings" icon={Settings} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}
