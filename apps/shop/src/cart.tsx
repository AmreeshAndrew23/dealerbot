// One cart per dealer, kept on this phone (it survives a reload; nothing is ordered until the shop
// sends it and replies YES in the chat).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CartItem } from "./api";

type Carts = Record<string, CartItem[]>;
const KEY = "fmcg-shop-carts";

function load(): Carts {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

interface CartApi {
  items: (dealer: string) => CartItem[];
  qty: (dealer: string, sku: string, unit: string) => number;
  set: (dealer: string, sku: string, unit: string, qty: number) => void;
  replace: (dealer: string, items: CartItem[]) => void;
  clear: (dealer: string) => void;
}
const Ctx = createContext<CartApi | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [carts, setCarts] = useState<Carts>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(carts));
    } catch {
      /* private mode: the cart lasts until the page closes */
    }
  }, [carts]);
  const set = useCallback((dealer: string, sku: string, unit: string, qty: number) => {
    setCarts((c) => {
      const list = (c[dealer] ?? []).filter((i) => !(i.sku === sku && i.unit === unit));
      if (qty > 0) {
        const at = (c[dealer] ?? []).findIndex((i) => i.sku === sku && i.unit === unit);
        list.splice(at < 0 ? list.length : at, 0, { sku, unit, qty });
      }
      return { ...c, [dealer]: list };
    });
  }, []);
  const api = useMemo<CartApi>(
    () => ({
      items: (d) => carts[d] ?? [],
      qty: (d, sku, unit) => carts[d]?.find((i) => i.sku === sku && i.unit === unit)?.qty ?? 0,
      set,
      replace: (d, items) => setCarts((c) => ({ ...c, [d]: items })),
      clear: (d) => setCarts((c) => ({ ...c, [d]: [] })),
    }),
    [carts, set],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCart(): CartApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCart outside CartProvider");
  return c;
}
