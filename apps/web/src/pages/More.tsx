import { Link } from "react-router-dom";
import { useMe } from "../auth";
import { ROLE_LABEL, useSignOut } from "../App";
import { Icon } from "../icons";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  soon?: boolean;
  perm?: string;
}

/** Phone-only menu for everything that is not in the bottom tab bar. */
export function MorePage({ nav }: { nav: NavItem[] }) {
  const me = useMe();
  const signOut = useSignOut();
  const items = nav.filter((n) => !["/orders", "/conversations", "/catalogue"].includes(n.to) && (!n.perm || me.permissions.includes(n.perm)));
  return (
    <div className="page">
      <div className="card card-pad account">
        <span className="avatar" aria-hidden="true">
          {me.user.display_name.slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{me.user.display_name}</div>
          <div className="cell-sub">
            {ROLE_LABEL[me.role]} · {me.tenant?.name}
          </div>
          <div className="cell-sub">{me.user.email}</div>
        </div>
      </div>
      <div className="card menu-list">
        {items.map((n) => (
          <Link key={n.to} to={n.to}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.soon && <span className="badge neutral">soon</span>}
            <span className="chev" aria-hidden="true">
              <Icon name="chevron" size={16} />
            </span>
          </Link>
        ))}
        <button type="button" onClick={() => signOut.mutate()}>
          <Icon name="logout" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}
