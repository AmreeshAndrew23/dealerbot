import { Icon } from "../icons";

export function ComingSoon({ title, icon, points }: { title: string; icon: string; points: string[] }) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="card card-pad soon-card">
        <span className="soon-icon" aria-hidden="true">
          <Icon name={icon} size={26} />
        </span>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Coming in the next step</div>
          <ul>
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
