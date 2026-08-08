import { useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Home } from './routes/home';
import { MemoryPath } from './routes/memory-path';
import { SkillsList } from './routes/skills-list';
import { SkillDetail } from './routes/skill-detail';
import { Search } from './routes/search';
import { T5tBoard } from './routes/t5t-board';
import { T5tProject } from './routes/t5t-project';
import { AgentsList } from './routes/agents';
import { Chat } from './routes/chat';
import { UsersMemory } from './routes/users-memory';
import { CliAccess } from './routes/cli-access';
import { TokenLogin } from './components/token-login';
import { api } from './lib/api';
import { AUTH_REQUIRED_EVENT, clearApiToken, getApiToken } from './lib/auth';

function Brand() {
  return (
    <div className="brand" aria-label="MetaBot Personal Console">
      <span className="glyph" aria-hidden />
      <span className="brand-copy">
        <span className="name">MetaBot</span>
        <span className="tag">Personal Console</span>
      </span>
    </div>
  );
}

const SIDEBAR_STATE_KEY = 'metabot-core:sidebar-collapsed';
const THEME_STATE_KEY = 'metabot-core:theme';

type Theme = 'dark' | 'light';
type NavItem = {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  desc: string;
};

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: '⌘', end: true, desc: 'Recent memory and activity' },
      { to: '/chat', label: 'Chat', icon: '●', desc: 'Codex, Kimi Code and Claude turns' },
      { to: '/t5t', label: 'T5T', icon: '▦', desc: 'Goals, WIP and project status' },
      { to: '/memory', label: 'Memory', icon: '▤', desc: 'Documents and folders' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { to: '/skills', label: 'Skills', icon: '✦', desc: 'Reusable agent capabilities' },
      { to: '/agents', label: 'Agents', icon: '◉', desc: 'Registered bots' },
      { to: '/users', label: 'Users', icon: '◎', desc: 'Personal memory owners' },
      { to: '/cli', label: 'CLI Access', icon: '›_', desc: 'Local token and commands' },
    ],
  },
];

function readSidebarCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_STATE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    return false;
  }
  // No stored preference yet: collapse by default on phone-width screens so the
  // content — not the nav tree — owns the first screen on mobile. Desktop keeps
  // the sidebar open. Once the user toggles it, their choice is remembered.
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 640px)').matches
    );
  } catch {
    return false;
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STATE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={`switch to ${next} mode  ( t )`}
      aria-label={`switch to ${next} mode`}
      aria-pressed={theme === 'light'}
    >
      {theme === 'dark' ? '☾' : '☀'}
    </button>
  );
}

function SidebarToggle({ collapsed, onToggle, label }: { collapsed: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      type="button"
      className="sidebar-toggle"
      onClick={onToggle}
      title={collapsed ? 'show sidebar  ( [ )' : 'hide sidebar  ( [ )'}
      aria-label={collapsed ? 'show sidebar' : 'hide sidebar'}
      aria-pressed={collapsed}
    >
      <span aria-hidden>{collapsed ? '☰' : '‹'}</span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}

function SearchBar({ compact = false }: { compact?: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const initial = new URLSearchParams(loc.search).get('q') || '';
  const [q, setQ] = useState(initial);

  useEffect(() => {
    setQ(new URLSearchParams(loc.search).get('q') || '');
  }, [loc.search]);

  return (
    <form
      className={compact ? 'search-bar search-bar-compact' : 'search-bar'}
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = q.trim();
        if (!trimmed) return;
        nav(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
    >
      <span className="prompt">›</span>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search memory + skills…  ( / )"
        spellCheck={false}
        autoComplete="off"
      />
    </form>
  );
}

function NavEntry({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}
      aria-label={collapsed ? `${item.label}: ${item.desc}` : undefined}
      title={collapsed ? item.label : item.desc}
    >
      <span className="app-nav-icon" aria-hidden>
        {item.icon}
      </span>
      <span className="app-nav-copy">
        <span className="app-nav-label">{item.label}</span>
        <span className="app-nav-desc">{item.desc}</span>
      </span>
    </NavLink>
  );
}

function Shell({ children, onSignOut }: { children: React.ReactNode; onSignOut: () => void }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  const currentSection = useMemo(() => {
    for (const group of NAV_GROUPS) {
      const match = group.items.find((item) =>
        item.end ? loc.pathname === item.to : loc.pathname === item.to || loc.pathname.startsWith(`${item.to}/`),
      );
      if (match) return match;
    }
    return { label: 'Console', desc: 'MetaBot Personal Edition' };
  }, [loc.pathname]);

  const toggleSidebar = () => {
    setSidebarCollapsed((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(SIDEBAR_STATE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_STATE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    setMenuOpen(false);
  }, [loc.pathname]);

  // global shortcuts:
  //   '/'  focus search input
  //   '['  toggle sidebar
  //   't'  toggle light/dark theme
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === '/' && !inField) {
        const el = document.querySelector<HTMLInputElement>('.search-bar input');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      } else if (e.key === '[' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 't' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleTheme();
      } else if (e.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <div className="app-scrim" aria-hidden onClick={() => setMenuOpen(false)} />
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="app-sidebar-head">
          <Brand />
        </div>
        <nav className="app-nav">
          {NAV_GROUPS.map((group) => (
            <section className="app-nav-group" key={group.label}>
              <div className="app-nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavEntry key={item.to} item={item} collapsed={sidebarCollapsed} />
              ))}
            </section>
          ))}
        </nav>
        <div className="app-sidebar-foot">
          <SidebarToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        </div>
      </aside>
      <div className="app-column">
        <header className="top-bar">
          <div className="brand-row">
            <SidebarToggle collapsed onToggle={() => setMenuOpen((open) => !open)} label="menu" />
            <div className="route-title">
              <span>{currentSection.label}</span>
              <small>{currentSection.desc}</small>
            </div>
          </div>
          <SearchBar />
          <nav className="actions" aria-label="Console actions">
            <span className="edition-pill">Personal</span>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <button className="signout" type="button" onClick={onSignOut} title="forget this browser token">
              sign out
            </button>
          </nav>
        </header>
        <div className="mobile-search">
          <SearchBar compact />
        </div>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<'checking' | 'required' | 'authenticated'>(
    getApiToken() ? 'checking' : 'required',
  );

  useEffect(() => {
    const requireAuth = () => setAuthState('required');
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuth);
    if (authState === 'checking') {
      void api
        .whoami()
        .then(() => setAuthState('authenticated'))
        .catch(() => setAuthState('required'));
    }
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuth);
  }, [authState]);

  if (authState === 'checking') {
    return (
      <div className="login">
        <div className="state">checking token…</div>
      </div>
    );
  }
  if (authState === 'required') {
    return <TokenLogin onAuthenticated={() => setAuthState('authenticated')} />;
  }

  const signOut = () => {
    clearApiToken();
    setAuthState('required');
  };

  return (
    <Shell onSignOut={signOut}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/memory/*" element={<MemoryPath />} />
        <Route path="/skills" element={<SkillsList />} />
        <Route path="/skills/:name" element={<SkillDetail />} />
        <Route path="/t5t" element={<T5tBoard />} />
        <Route path="/t5t/:slug" element={<T5tProject />} />
        <Route path="/users" element={<UsersMemory />} />
        <Route path="/agents" element={<AgentsList />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/cli" element={<CliAccess />} />
        <Route path="/search" element={<Search />} />
        <Route path="*" element={<div className="content state">404 · no such route</div>} />
      </Routes>
    </Shell>
  );
}
