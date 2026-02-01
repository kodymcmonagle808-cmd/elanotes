import { useState, useEffect, useCallback, useRef } from "https://esm.sh/react@18.2.0?dev";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const GITHUB_REPOS = [
  { owner: "HCPSS", repo: "upptime", label: "Main Services" },
  { owner: "HCPSS", repo: "status",  label: "Async Instructional" },
];
const POLL_INTERVAL_MS = 60_000; // 60 s

const STATUS_COLORS = {
  up:       { bg: "#16a34a", text: "#bbf7d0", glow: "rgba(22,163,74,0.5)" },
  down:     { bg: "#dc2626", text: "#fecaca", glow: "rgba(220,38,38,0.6)" },
  unknown:  { bg: "#ca8a04", text: "#fef08a", glow: "rgba(202,138,4,0.5)" },
};

// ─── FAKE GOOGLE AUTH (simulates the flow) ──────────────────────────────────
function useGoogleAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check persisted session
    try {
      const saved = sessionStorage.getItem("hcpss_user");
      if (saved) setUser(JSON.parse(saved));
    } catch {}
    setLoading(false);
  }, []);

  const login = useCallback(() => {
    // Simulate Google popup → instant sign-in with avatar
    const fakeUser = {
      id: "google_" + Math.random().toString(36).slice(2, 10),
      name: "HCPSS User",
      email: "user@howard.edu",
      avatar: "https://i.pravatar.cc/150?img=" + Math.floor(Math.random() * 70 + 1),
      provider: "google",
    };
    setUser(fakeUser);
    try { sessionStorage.setItem("hcpss_user", JSON.stringify(fakeUser)); } catch {}
  }, []);

  const signup = useCallback(() => {
    const fakeUser = {
      id: "google_signup_" + Math.random().toString(36).slice(2, 10),
      name: "New HCPSS User",
      email: "newuser@howard.edu",
      avatar: "https://i.pravatar.cc/150?img=" + Math.floor(Math.random() * 70 + 1),
      provider: "google",
      isNew: true,
    };
    setUser(fakeUser);
    try { sessionStorage.setItem("hcpss_user", JSON.stringify(fakeUser)); } catch {}
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    try { sessionStorage.removeItem("hcpss_user"); } catch {}
  }, []);

  return { user, loading, login, signup, logout };
}

// ─── NOTIFICATION MANAGER ───────────────────────────────────────────────────
function useNotifications() {
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [emailEnabled,  setEmailEnabled]  = useState(false);
  const [smsEnabled,    setSmsEnabled]    = useState(false);
  const [email, setEmail]                 = useState("");
  const [phone, setPhone]                 = useState("");

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "granted") {
      setDesktopEnabled(true);
    }
  }, []);

  const requestDesktop = async () => {
    if ("Notification" in window) {
      const perm = await Notification.requestPermission();
      setDesktopEnabled(perm === "granted");
    }
  };

  const fireDesktop = useCallback((title, body, icon = "🟥") => {
    if (desktopEnabled && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body,
          icon: "/favicon.ico",
          badge: "/favicon.ico",
          silent: false,
        });
      } catch {}
    }
  }, [desktopEnabled]);

  return {
    desktopEnabled, requestDesktop, fireDesktop,
    emailEnabled, setEmailEnabled, email, setEmail,
    smsEnabled, setSmsEnabled, phone, setPhone,
  };
}

// ─── GITHUB API FETCHER ──────────────────────────────────────────────────────
async function fetchRepoServices(owner, repo) {
  // 1) Fetch summary.json from raw content
  const summaryUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/history/summary.json`;
  let summary = [];
  try {
    const r = await fetch(summaryUrl);
    if (r.ok) summary = await r.json();
  } catch {}

  // 2) Fetch open issues (incidents) via GitHub API
  let incidents = [];
  try {
    const issuesUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&labels=bug&per_page=10`;
    const r2 = await fetch(issuesUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (r2.ok) incidents = await r2.json();
  } catch {}

  // 3) Also fetch closed issues (recent incidents)
  let closedIncidents = [];
  try {
    const closedUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=closed&labels=bug&per_page=5`;
    const r3 = await fetch(closedUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (r3.ok) closedIncidents = await r3.json();
  } catch {}

  return { summary, incidents, closedIncidents };
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const { user, loading: authLoading, login, signup, logout } = useGoogleAuth();
  const notif = useNotifications();

  // State
  const [allServices, setAllServices] = useState([]);
  const [allIncidents, setAllIncidents] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [polling, setPolling] = useState(false);
  const [page, setPage] = useState("dashboard"); // dashboard | settings | incidents
  const prevStatusRef = useRef({});
  const isFirstPoll = useRef(true);

  // ── POLL LOOP ──
  const poll = useCallback(async () => {
    setPolling(true);
    let services = [];
    let incidents = [];

    for (const { owner, repo, label } of GITHUB_REPOS) {
      const data = await fetchRepoServices(owner, repo);

      // Map summary entries to service objects
      const mapped = data.summary.map((s) => ({
        id: `${owner}/${repo}/${s.name}`,
        repo: label,
        name: s.name,
        status: s.status === "up" ? "up" : "down",
        responseTime: s.responseTime ?? null,
        uptime: s.uptime ?? null,
      }));
      services.push(...mapped);

      // Map incidents
      const mappedIncidents = [...data.incidents, ...data.closedIncidents].map((i) => ({
        id: i.number,
        repo: label,
        title: i.title,
        state: i.state,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        url: i.html_url,
        body: i.body || "",
      }));
      incidents.push(...mappedIncidents);
    }

    // ── CHANGE DETECTION & DESKTOP NOTIFICATION ──
    if (!isFirstPoll.current) {
      services.forEach((svc) => {
        const prev = prevStatusRef.current[svc.id];
        if (prev && prev !== svc.status) {
          const emoji = svc.status === "up" ? "🟩" : "🟥";
          notif.fireDesktop(
            `${emoji} HCPSS: ${svc.name}`,
            `Status changed to ${svc.status.toUpperCase()} — ${svc.repo}`
          );
        }
      });
    }
    isFirstPoll.current = false;

    // Save current statuses for next diff
    const newRef = {};
    services.forEach((s) => { newRef[s.id] = s.status; });
    prevStatusRef.current = newRef;

    setAllServices(services);
    setAllIncidents(incidents);
    setLastUpdated(new Date());
    setPolling(false);
  }, [notif]);

  useEffect(() => {
    if (user) {
      poll();
      const interval = setInterval(poll, POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }
  }, [user, poll]);

  // ── RENDER ROUTING ──
  if (authLoading) return <div style={styles.splash}><Spinner /></div>;
  if (!user) return <AuthScreen login={login} signup={signup} />;

  const downCount = allServices.filter((s) => s.status === "down").length;
  const upCount  = allServices.filter((s) => s.status === "up").length;
  const openIncidents = allIncidents.filter((i) => i.state === "open");

  return (
    <div style={styles.root}>
      {/* TOPBAR */}
      <TopBar user={user} logout={logout} page={page} setPage={setPage} downCount={downCount} openIncidents={openIncidents.length} />

      {/* MAIN */}
      <main style={styles.main}>
        {page === "dashboard" && (
          <Dashboard
            services={allServices}
            incidents={allIncidents}
            lastUpdated={lastUpdated}
            polling={polling}
            onRefresh={poll}
            downCount={downCount}
            upCount={upCount}
            openIncidents={openIncidents}
          />
        )}
        {page === "incidents" && <IncidentPage incidents={allIncidents} />}
        {page === "settings" && <SettingsPage user={user} notif={notif} />}
      </main>
    </div>
  );
}

// ─── AUTH SCREEN ─────────────────────────────────────────────────────────────
function AuthScreen({ login, signup }) {
  return (
    <div style={styles.authRoot}>
      {/* Animated background particles */}
      <div style={styles.authBg} aria-hidden="true">
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i} style={{
            ...styles.particle,
            width: 6 + (i % 5) * 8,
            height: 6 + (i % 5) * 8,
            left: `${(i * 5.3) % 100}%`,
            top: `${(i * 7.1) % 100}%`,
            animationDelay: `${i * 0.3}s`,
            animationDuration: `${4 + (i % 4)}s`,
          }} />
        ))}
      </div>

      <div style={styles.authCard}>
        {/* Logo */}
        <div style={styles.authLogo}>
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <circle cx="28" cy="28" r="28" fill="#0d2818" stroke="#16a34a" strokeWidth="2"/>
            <path d="M28 10 L44 20 L44 36 L28 46 L12 36 L12 20 Z" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinejoin="round"/>
            <circle cx="28" cy="28" r="6" fill="#16a34a"/>
            <circle cx="28" cy="28" r="3" fill="#bbf7d0"/>
          </svg>
        </div>
        <h1 style={styles.authTitle}>HCPSS Status Monitor</h1>
        <p style={styles.authSub}>Real-time alerts for Howard County Public Schools</p>

        <button style={styles.googleBtn} onClick={login}>
          <GoogleIcon /> Sign In with Google
        </button>
        <div style={styles.divider}><span style={styles.dividerText}>or</span></div>
        <button style={{ ...styles.googleBtn, ...styles.googleBtnOutline }} onClick={signup}>
          <GoogleIcon /> Create Account with Google
        </button>

        <p style={styles.authFooter}>
          By signing in you agree to receive status notifications.<br/>
          Desktop notifications can be configured after login.
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" style={{ marginRight: 10 }}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

// ─── TOPBAR ──────────────────────────────────────────────────────────────────
function TopBar({ user, logout, page, setPage, downCount, openIncidents }) {
  return (
    <header style={styles.topBar}>
      <div style={styles.topBarLeft}>
        <div style={styles.topBarLogo}>
          <svg width="28" height="28" viewBox="0 0 56 56" fill="none">
            <circle cx="28" cy="28" r="28" fill="#0d2818" stroke="#16a34a" strokeWidth="2.5"/>
            <circle cx="28" cy="28" r="8" fill="#16a34a"/>
            <circle cx="28" cy="28" r="4" fill="#bbf7d0"/>
          </svg>
          <span style={styles.topBarTitle}>HCPSS Monitor</span>
        </div>
      </div>
      <nav style={styles.topBarNav}>
        {[
          { key: "dashboard", label: "Dashboard" },
          { key: "incidents", label: "Incidents", badge: openIncidents },
          { key: "settings",  label: "Settings" },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setPage(item.key)}
            style={{ ...styles.navBtn, ...(page === item.key ? styles.navBtnActive : {}) }}
          >
            {item.label}
            {item.badge > 0 && <span style={styles.navBadge}>{item.badge}</span>}
          </button>
        ))}
      </nav>
      <div style={styles.topBarRight}>
        {downCount > 0 && <span style={styles.downBadge}>⚠ {downCount} Down</span>}
        <img src={user.avatar} alt={user.name} style={styles.avatar} />
        <button style={styles.logoutBtn} onClick={logout}>✕</button>
      </div>
    </header>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function Dashboard({ services, incidents, lastUpdated, polling, onRefresh, downCount, upCount, openIncidents }) {
  const grouped = {};
  services.forEach((s) => {
    (grouped[s.repo] = grouped[s.repo] || []).push(s);
  });

  return (
    <div style={styles.dashRoot}>
      {/* SUMMARY CARDS */}
      <div style={styles.summaryRow}>
        <SummaryCard label="Total Services" value={services.length} color="#16a34a" icon="📡" />
        <SummaryCard label="Operational" value={upCount} color="#16a34a" icon="✅" />
        <SummaryCard label="Down" value={downCount} color="#dc2626" icon="🔴" />
        <SummaryCard label="Open Incidents" value={openIncidents.length} color="#ca8a04" icon="⚠️" />
      </div>

      {/* REFRESH BAR */}
      <div style={styles.refreshBar}>
        <span style={styles.refreshText}>
          {lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : "Fetching…"}
        </span>
        <button style={styles.refreshBtn} onClick={onRefresh} disabled={polling}>
          {polling ? "⟳ Refreshing…" : "⟳ Refresh"}
        </button>
      </div>

      {/* SERVICE GROUPS */}
      {Object.entries(grouped).map(([repo, svcs]) => (
        <div key={repo} style={styles.serviceGroup}>
          <h3 style={styles.groupTitle}>{repo}</h3>
          <div style={styles.serviceGrid}>
            {svcs.map((svc) => <ServiceCard key={svc.id} svc={svc} />)}
          </div>
        </div>
      ))}

      {/* EMPTY STATE */}
      {services.length === 0 && (
        <div style={styles.emptyState}>
          <Spinner />
          <p style={styles.emptyText}>Pulling live data from GitHub…</p>
        </div>
      )}

      {/* RECENT INCIDENTS STRIP */}
      {openIncidents.length > 0 && (
        <div style={styles.incidentStrip}>
          <h3 style={styles.stripTitle}>🔴 Active Incidents</h3>
          {openIncidents.slice(0, 3).map((inc) => (
            <div key={inc.id} style={styles.stripItem}>
              <span style={styles.stripRepo}>{inc.repo}</span>
              <span style={styles.stripIncTitle}>{inc.title}</span>
              <a href={inc.url} target="_blank" rel="noopener noreferrer" style={styles.stripLink}>→</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color, icon }) {
  return (
    <div style={{ ...styles.summaryCard, borderColor: color }}>
      <div style={styles.summaryIcon}>{icon}</div>
      <div style={{ ...styles.summaryValue, color }}>{value}</div>
      <div style={styles.summaryLabel}>{label}</div>
    </div>
  );
}

function ServiceCard({ svc }) {
  const c = STATUS_COLORS[svc.status] || STATUS_COLORS.unknown;
  return (
    <div style={{ ...styles.svcCard, boxShadow: `0 0 12px ${c.glow}` }}>
      <div style={styles.svcCardTop}>
        <div style={{ ...styles.svcDot, background: c.bg, boxShadow: `0 0 8px ${c.glow}` }} />
        <span style={{ ...styles.svcStatus, color: c.text }}>{svc.status.toUpperCase()}</span>
      </div>
      <div style={styles.svcName}>{svc.name}</div>
      <div style={styles.svcMeta}>
        {svc.responseTime !== null && <span>⚡ {svc.responseTime}ms</span>}
        {svc.uptime !== null && <span>📈 {svc.uptime}%</span>}
      </div>
      <div style={{ ...styles.svcBar, background: "#1a3a2a" }}>
        <div style={{
          ...styles.svcBarFill,
          width: `${Math.min(svc.uptime || 0, 100)}%`,
          background: c.bg,
        }} />
      </div>
    </div>
  );
}

// ─── INCIDENTS PAGE ──────────────────────────────────────────────────────────
function IncidentPage({ incidents }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? incidents : incidents.filter((i) => i.state === filter);

  return (
    <div style={styles.incidentRoot}>
      <div style={styles.incidentHeader}>
        <h2 style={styles.incidentTitle}>Incident History</h2>
        <div style={styles.filterRow}>
          {["all", "open", "closed"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{ ...styles.filterBtn, ...(filter === f ? styles.filterBtnActive : {}) }}
            >{f}</button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div style={styles.emptyState}>
          <p style={styles.emptyText}>No incidents found.</p>
        </div>
      ) : (
        <div style={styles.incidentList}>
          {filtered.map((inc) => (
            <IncidentCard key={`${inc.repo}-${inc.id}`} inc={inc} />
          ))}
        </div>
      )}
    </div>
  );
}

function IncidentCard({ inc }) {
  const isOpen = inc.state === "open";
  return (
    <div style={{ ...styles.incCard, borderLeft: `3px solid ${isOpen ? "#dc2626" : "#16a34a"}` }}>
      <div style={styles.incCardTop}>
        <span style={{ ...styles.incBadge, background: isOpen ? "#dc262622" : "#16a34a22", color: isOpen ? "#fca5a5" : "#86efac" }}>
          {isOpen ? "🔴 OPEN" : "✅ RESOLVED"}
        </span>
        <span style={styles.incRepo}>{inc.repo}</span>
        <a href={inc.url} target="_blank" rel="noopener noreferrer" style={styles.incLink}>GitHub →</a>
      </div>
      <h4 style={styles.incTitle2}>{inc.title}</h4>
      {inc.body && <p style={styles.incBody}>{inc.body.slice(0, 200)}{inc.body.length > 200 ? "…" : ""}</p>}
      <div style={styles.incDates}>
        <span>Created: {new Date(inc.createdAt).toLocaleString()}</span>
        <span>Updated: {new Date(inc.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}

// ─── SETTINGS PAGE ───────────────────────────────────────────────────────────
function SettingsPage({ user, notif }) {
  return (
    <div style={styles.settingsRoot}>
      {/* Profile */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>👤 Profile</h3>
        <div style={styles.profileRow}>
          <img src={user.avatar} alt={user.name} style={styles.profileAvatar} />
          <div>
            <div style={styles.profileName}>{user.name}</div>
            <div style={styles.profileEmail}>{user.email}</div>
            <div style={styles.profileProvider}>Signed in via Google</div>
          </div>
        </div>
      </div>

      {/* Desktop Notifications */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>🔔 Desktop Notifications</h3>
        <p style={styles.settingsDesc}>Get instant alerts when any HCPSS service status changes.</p>
        {notif.desktopEnabled ? (
          <div style={styles.enabledBadge}>✅ Desktop notifications enabled</div>
        ) : (
          <button style={styles.enableBtn} onClick={notif.requestDesktop}>
            Enable Desktop Notifications
          </button>
        )}
      </div>

      {/* Email (stub) */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>📧 Email Notifications</h3>
        <p style={styles.settingsDesc}>Receive status change alerts via email. <em style={{ color: "#ca8a04" }}>(Coming soon)</em></p>
        <div style={styles.inputRow}>
          <input
            type="email"
            value={notif.email}
            onChange={(e) => notif.setEmail(e.target.value)}
            placeholder="your@email.com"
            style={styles.input}
            disabled
          />
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={notif.emailEnabled} onChange={(e) => notif.setEmailEnabled(e.target.checked)} disabled style={{ marginRight: 8 }} />
            Enable
          </label>
        </div>
        <div style={styles.comingSoon}>⏳ Email notifications will be available soon.</div>
      </div>

      {/* SMS (stub) */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>📱 SMS Notifications</h3>
        <p style={styles.settingsDesc}>Receive status change alerts via SMS text message. <em style={{ color: "#ca8a04" }}>(Coming soon)</em></p>
        <div style={styles.inputRow}>
          <input
            type="tel"
            value={notif.phone}
            onChange={(e) => notif.setPhone(e.target.value)}
            placeholder="+1 (410) 555-0123"
            style={styles.input}
            disabled
          />
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={notif.smsEnabled} onChange={(e) => notif.setSmsEnabled(e.target.checked)} disabled style={{ marginRight: 8 }} />
            Enable
          </label>
        </div>
        <div style={styles.comingSoon}>⏳ SMS notifications will be available soon.</div>
      </div>

      {/* Polling Info */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>⚙️ Monitoring</h3>
        <p style={styles.settingsDesc}>
          This app polls the HCPSS GitHub repositories every <strong style={{ color: "#16a34a" }}>60 seconds</strong> for live service status.
          When a status change is detected, you will be notified via your enabled channels.
        </p>
        <div style={styles.infoGrid}>
          <div style={styles.infoItem}><span style={styles.infoLabel}>Sources</span><span style={styles.infoVal}>HCPSS/upptime, HCPSS/status</span></div>
          <div style={styles.infoItem}><span style={styles.infoLabel}>Poll Interval</span><span style={styles.infoVal}>60 seconds</span></div>
          <div style={styles.infoItem}><span style={styles.infoLabel}>Change Detection</span><span style={styles.infoVal}>Diff on every poll</span></div>
        </div>
      </div>
    </div>
  );
}

// ─── SPINNER ─────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={styles.spinner}>
      <div style={styles.spinnerInner} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════
const styles = {
  // Root
  root: {
    minHeight: "100vh",
    background: "#0a1f14",
    color: "#c8e6d4",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
  },

  // Splash
  splash: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0a1f14",
  },

  // ── AUTH ──
  authRoot: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(145deg, #0a1f14 0%, #0d2818 40%, #0a1a12 100%)",
    position: "relative",
    overflow: "hidden",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    color: "#c8e6d4",
  },
  authBg: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
  },
  particle: {
    position: "absolute",
    borderRadius: "50%",
    background: "radial-gradient(circle, #16a34a33, transparent)",
    border: "1px solid #16a34a22",
    animation: "floatParticle linear infinite",
  },
  authCard: {
    position: "relative",
    zIndex: 1,
    background: "linear-gradient(135deg, #0d2818 0%, #112b1d 100%)",
    border: "1px solid #16a34a33",
    borderRadius: 24,
    padding: "48px 40px",
    maxWidth: 420,
    width: "90%",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0,0,0,0.4), 0 0 40px rgba(22,163,74,0.08)",
  },
  authLogo: { marginBottom: 20 },
  authTitle: {
    fontSize: 26,
    fontWeight: 700,
    color: "#e2f0e8",
    margin: "0 0 8px",
    letterSpacing: "-0.5px",
  },
  authSub: {
    fontSize: 14,
    color: "#7aaa8f",
    margin: "0 0 32px",
  },
  googleBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    padding: "14px 24px",
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 20px rgba(22,163,74,0.35)",
    transition: "all 0.2s",
    marginBottom: 12,
  },
  googleBtnOutline: {
    background: "transparent",
    border: "1px solid #16a34a55",
    color: "#86efac",
    boxShadow: "none",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    margin: "16px 0",
  },
  dividerText: {
    color: "#5a7a6a",
    fontSize: 13,
    padding: "0 12px",
    background: "transparent",
  },
  authFooter: {
    fontSize: 12,
    color: "#4a6a5a",
    marginTop: 28,
    lineHeight: 1.5,
  },

  // ── TOPBAR ──
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 24px",
    background: "#0d1f17",
    borderBottom: "1px solid #16a34a22",
    flexShrink: 0,
    gap: 16,
  },
  topBarLeft: { display: "flex", alignItems: "center" },
  topBarLogo: { display: "flex", alignItems: "center", gap: 10 },
  topBarTitle: { fontSize: 17, fontWeight: 700, color: "#e2f0e8", letterSpacing: "-0.3px" },
  topBarNav: { display: "flex", gap: 4 },
  navBtn: {
    padding: "7px 16px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 8,
    color: "#7aaa8f",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  navBtnActive: {
    background: "#16a34a18",
    borderColor: "#16a34a33",
    color: "#86efac",
  },
  navBadge: {
    background: "#dc2626",
    color: "#fff",
    borderRadius: 10,
    padding: "1px 7px",
    fontSize: 11,
    fontWeight: 700,
  },
  topBarRight: { display: "flex", alignItems: "center", gap: 10 },
  downBadge: {
    background: "#dc262620",
    color: "#fca5a5",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #dc262633",
  },
  avatar: { width: 32, height: 32, borderRadius: "50%", border: "2px solid #16a34a44" },
  logoutBtn: {
    background: "transparent",
    border: "1px solid #16a34a33",
    borderRadius: 6,
    color: "#7aaa8f",
    width: 28,
    height: 28,
    cursor: "pointer",
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // ── MAIN ──
  main: { flex: 1, overflow: "auto", padding: "24px" },

  // ── DASHBOARD ──
  dashRoot: { maxWidth: 1100, margin: "0 auto" },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 },
  summaryCard: {
    background: "#0d2818",
    border: "1px solid #16a34a22",
    borderRadius: 16,
    padding: "20px 18px",
    textAlign: "center",
    borderTopWidth: 3,
    transition: "transform 0.15s",
  },
  summaryIcon: { fontSize: 22, marginBottom: 8 },
  summaryValue: { fontSize: 28, fontWeight: 800, marginBottom: 4 },
  summaryLabel: { fontSize: 12, color: "#7aaa8f", textTransform: "uppercase", letterSpacing: 0.5 },

  refreshBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
    padding: "10px 16px",
    background: "#0d1f17",
    borderRadius: 10,
    border: "1px solid #16a34a1a",
  },
  refreshText: { fontSize: 12, color: "#5a7a6a" },
  refreshBtn: {
    background: "#16a34a18",
    border: "1px solid #16a34a44",
    color: "#86efac",
    borderRadius: 8,
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },

  // Service groups
  serviceGroup: { marginBottom: 24 },
  groupTitle: {
    fontSize: 14,
    color: "#5a7a6a",
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: 600,
    marginBottom: 12,
    paddingLeft: 4,
    borderLeft: "3px solid #16a34a",
    paddingLeft: 10,
  },
  serviceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },

  // Service card
  svcCard: {
    background: "#0d2818",
    border: "1px solid #16a34a22",
    borderRadius: 14,
    padding: 18,
    transition: "transform 0.15s, box-shadow 0.2s",
  },
  svcCardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  svcDot: { width: 10, height: 10, borderRadius: "50%" },
  svcStatus: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8 },
  svcName: { fontSize: 14, fontWeight: 600, color: "#e2f0e8", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  svcMeta: { display: "flex", gap: 12, fontSize: 11, color: "#5a7a6a", marginBottom: 10 },
  svcBar: { height: 4, borderRadius: 2, overflow: "hidden" },
  svcBarFill: { height: "100%", borderRadius: 2, transition: "width 0.4s" },

  // Empty
  emptyState: { textAlign: "center", padding: "60px 20px" },
  emptyText: { color: "#5a7a6a", fontSize: 15, marginTop: 16 },

  // Incident strip
  incidentStrip: {
    background: "#1a0e0e",
    border: "1px solid #dc262633",
    borderRadius: 14,
    padding: 18,
    marginTop: 24,
  },
  stripTitle: { fontSize: 14, fontWeight: 700, color: "#fca5a5", marginBottom: 12, margin: "0 0 12px" },
  stripItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #dc262618", fontSize: 13 },
  stripRepo: { color: "#7aaa8f", fontSize: 11, fontWeight: 600, minWidth: 100 },
  stripIncTitle: { flex: 1, color: "#e2f0e8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  stripLink: { color: "#dc2626", fontWeight: 700, textDecoration: "none" },

  // ── INCIDENTS PAGE ──
  incidentRoot: { maxWidth: 860, margin: "0 auto" },
  incidentHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  incidentTitle: { fontSize: 22, fontWeight: 700, color: "#e2f0e8", margin: 0 },
  filterRow: { display: "flex", gap: 6 },
  filterBtn: {
    padding: "6px 14px",
    background: "#0d2818",
    border: "1px solid #16a34a22",
    borderRadius: 8,
    color: "#7aaa8f",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textTransform: "capitalize",
  },
  filterBtnActive: { background: "#16a34a18", borderColor: "#16a34a55", color: "#86efac" },

  incidentList: { display: "flex", flexDirection: "column", gap: 12 },
  incCard: {
    background: "#0d2818",
    border: "1px solid #16a34a22",
    borderRadius: 14,
    padding: 18,
  },
  incCardTop: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  incBadge: { padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700 },
  incRepo: { fontSize: 11, color: "#5a7a6a", flex: 1 },
  incLink: { fontSize: 12, color: "#16a34a", fontWeight: 600, textDecoration: "none" },
  incTitle2: { fontSize: 16, fontWeight: 600, color: "#e2f0e8", margin: "0 0 8px" },
  incBody: { fontSize: 13, color: "#7aaa8f", margin: "0 0 10px", lineHeight: 1.5 },
  incDates: { display: "flex", gap: 24, fontSize: 11, color: "#4a6a5a" },

  // ── SETTINGS ──
  settingsRoot: { maxWidth: 700, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },
  settingsCard: {
    background: "#0d2818",
    border: "1px solid #16a34a22",
    borderRadius: 16,
    padding: 24,
  },
  settingsTitle: { fontSize: 16, fontWeight: 700, color: "#e2f0e8", margin: "0 0 8px" },
  settingsDesc: { fontSize: 13, color: "#7aaa8f", margin: "0 0 16px", lineHeight: 1.5 },
  enabledBadge: {
    display: "inline-block",
    background: "#16a34a18",
    color: "#86efac",
    padding: "6px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid #16a34a33",
  },
  enableBtn: {
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 22px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 3px 12px rgba(22,163,74,0.3)",
  },
  inputRow: { display: "flex", flexDirection: "column", gap: 10 },
  input: {
    background: "#0a1a12",
    border: "1px solid #16a34a22",
    borderRadius: 10,
    padding: "10px 14px",
    color: "#c8e6d4",
    fontSize: 14,
    outline: "none",
  },
  toggleLabel: { fontSize: 13, color: "#7aaa8f", display: "flex", alignItems: "center" },
  comingSoon: {
    marginTop: 12,
    padding: "8px 14px",
    background: "#1a1a0a",
    border: "1px solid #ca8a0433",
    borderRadius: 8,
    fontSize: 12,
    color: "#ca8a04",
  },
  profileRow: { display: "flex", alignItems: "center", gap: 16 },
  profileAvatar: { width: 56, height: 56, borderRadius: "50%", border: "2px solid #16a34a44" },
  profileName: { fontSize: 16, fontWeight: 600, color: "#e2f0e8" },
  profileEmail: { fontSize: 13, color: "#7aaa8f" },
  profileProvider: { fontSize: 11, color: "#4a6a5a", marginTop: 2 },
  infoGrid: { display: "flex", flexDirection: "column", gap: 8 },
  infoItem: { display: "flex", justifyContent: "space-between", fontSize: 13 },
  infoLabel: { color: "#5a7a6a" },
  infoVal: { color: "#86efac", fontWeight: 500 },

  // Spinner
  spinner: {
    width: 36,
    height: 36,
    margin: "0 auto",
  },
  spinnerInner: {
    width: "100%",
    height: "100%",
    border: "3px solid #16a34a22",
    borderTop: "3px solid #16a34a",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
};

// ── CSS KEYFRAMES (injected via style tag) ─────────────────────────────────
const cssKeyframes = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes floatParticle {
    0%   { transform: translateY(0px) scale(1); opacity: 0; }
    10%  { opacity: 1; }
    90%  { opacity: 1; }
    100% { transform: translateY(-120vh) scale(0.5); opacity: 0; }
  }
  button:hover { filter: brightness(1.15); }
  a:hover { opacity: 0.75; }
  input:focus { border-color: #16a34a66 !important; }
`;

// Inject keyframes once
if (typeof document !== "undefined" && !document.getElementById("hcpss-keyframes")) {
  const el = document.createElement("style");
  el.id = "hcpss-keyframes";
  el.textContent = cssKeyframes;
  document.head.appendChild(el);
}
