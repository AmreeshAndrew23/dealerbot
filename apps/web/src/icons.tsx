const PATHS: Record<string, string> = {
  orders: "M7 3h10a2 2 0 0 1 2 2v15l-3-2-2 2-2-2-2 2-2-2-3 2V5a2 2 0 0 1 2-2zm2 5h6M9 12h6",
  chat: "M4 5h16v10H9l-5 4V5z",
  box: "M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7M12 11v10",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8zm5 8v5",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  menu: "M4 6h16M4 12h16M4 18h16",
  back: "M15 5l-7 7 7 7",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0",
  bot: "M12 3v3M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zm2 5h.01M15 13h.01",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm5-2l4 4",
  logo: "M6 8h12M6 12h8M6 16h5",
  more: "M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM19 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  chevron: "M9 6l6 6-6 6",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  plus: "M12 5v14M5 12h14",
  upload: "M12 15V4M7 9l5-5 5 5M4 15v5h16v-5",
  download: "M12 4v11M7 10l5 5 5-5M4 15v5h16v-5",
  close: "M6 6l12 12M18 6L6 18",
  store: "M4 9l1.5-5h13L20 9M4 9h16M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 11v9h14v-9M10 20v-5h4v5",
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
