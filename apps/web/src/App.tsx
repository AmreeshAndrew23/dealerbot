import { NavLink, Navigate, Route, Routes, useMatch, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "./api";
import { RequireAuth, useMe } from "./auth";
import { LoginPage } from "./pages/Login";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { ConversationsPage } from "./pages/Conversations";
import { UsersPage } from "./pages/Users";
import { ComingSoon } from "./pages/ComingSoon";
import { CataloguePage } from "./pages/Catalogue";
import { OrdersPage } from "./pages/Orders";
import { RetailersPage } from "./pages/Retailers";
import { MorePage } from "./pages/More";
import { Icon } from "./icons";

export const ROLE_LABEL = { OWNER: "Owner", OPERATOR: "Operator", VIEWER: "Viewer" } as const;

export function useSignOut() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: () => api("/v1/auth/logout", { method: "POST", body: {} }),
    onSettled: () => {
      qc.clear();
      nav("/login");
    },
  });
}

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: string;
  soon?: boolean;
  perm?: string;
}

const NAV: NavItem[] = [
  { to: "/orders", label: "Orders", short: "Orders", icon: "orders", perm: "orders.view" },
  { to: "/conversations", label: "Conversations", short: "Chats", icon: "chat" },
  { to: "/catalogue", label: "Catalogue", short: "Catalogue", icon: "box", perm: "catalogue.view" },
  { to: "/retailers", label: "Retailers", short: "Retailers", icon: "store", perm: "orders.view" },
  { to: "/integration", label: "Tally integration", short: "Tally", icon: "plug", soon: true },
  { to: "/admin/users", label: "Users", short: "Users", icon: "users", perm: "users.manage" },
];

/** Desktop and tablet: left sidebar. */
function Sidebar() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const signOut = useSignOut();
  const switchTenant = useMutation({
    mutationFn: (tenant_id: string) => api<Me>("/v1/auth/switch-tenant", { method: "POST", body: { tenant_id } }),
    onSuccess: () => {
      qc.clear();
      nav("/conversations");
    },
  });
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="logo" />
        </span>
        <span style={{ minWidth: 0 }}>
          Order Assistant
          <span className="tenant-name">{me.tenant?.name}</span>
        </span>
      </div>
      <nav className="nav">
        {NAV.filter((n) => !n.perm || me.permissions.includes(n.perm)).map((n) => (
          <NavLink key={n.to} to={n.to}>
            <Icon name={n.icon} />
            {n.label}
            {n.soon && <span className="soon">soon</span>}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div>
          <div className="who">{me.user.display_name}</div>
          <div className="role">{ROLE_LABEL[me.role]}</div>
        </div>
        {me.tenants.length > 1 && (
          <label>
            <span className="role">Distributor</span>
            <select value={me.tenant?.id} onChange={(e) => switchTenant.mutate(e.target.value)} style={{ width: "100%" }}>
              {me.tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="linkbtn" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

/** Phones: bottom tab bar with the four most used destinations; the rest live under "More". */
function TabBar() {
  const me = useMe();
  const tabs = NAV.filter((n) => ["/orders", "/conversations", "/catalogue"].includes(n.to) && (!n.perm || me.permissions.includes(n.perm)));
  return (
    <nav className="tabbar" aria-label="Main navigation">
      {tabs.map((n) => (
        <NavLink key={n.to} to={n.to}>
          <Icon name={n.icon} size={22} />
          <span>{n.short}</span>
        </NavLink>
      ))}
      <NavLink to="/more">
        <Icon name="more" size={22} />
        <span>More</span>
      </NavLink>
    </nav>
  );
}

function Shell() {
  // An open chat on a phone is full screen, like WhatsApp: no tab bar under the composer.
  const chatOpen = useMatch("/conversations/:id") !== null;
  const orderOpen = useMatch("/orders/:id") !== null;
  const inThread = chatOpen || orderOpen;
  return (
    <div className={`shell${inThread ? " in-thread" : ""}`}>
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationsPage />} />
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/more" element={<MorePage nav={NAV} />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:id" element={<OrdersPage />} />
          <Route path="/catalogue" element={<CataloguePage />} />
          <Route path="/retailers" element={<RetailersPage />} />
          <Route
            path="/integration"
            element={
              <ComingSoon title="Tally integration" icon="plug" points={["Connector status", "Last product and price sync", "Sales Orders sent to Tally"]} />
            }
          />
          <Route path="*" element={<Navigate to="/conversations" replace />} />
        </Routes>
      </main>
      <TabBar />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
