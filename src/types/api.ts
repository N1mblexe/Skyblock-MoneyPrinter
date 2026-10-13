// Raw Hypixel API response shapes (only the fields we use).

export interface RawOrder {
  amount: number;
  pricePerUnit: number;
  orders: number;
}

export interface RawQuickStatus {
  productId: string;
  sellPrice: number;
  sellVolume: number;
  sellMovingWeek: number;
  sellOrders: number;
  buyPrice: number;
  buyVolume: number;
  buyMovingWeek: number;
  buyOrders: number;
}

export interface RawProduct {
  product_id: string;
  /** BUY ORDERS (what an insta-sell hits), sorted by price desc. */
  sell_summary: RawOrder[];
  /** SELL OFFERS (what an insta-buy hits), sorted by price asc. */
  buy_summary: RawOrder[];
  quick_status: RawQuickStatus;
}

export interface RawBazaar {
  success: boolean;
  lastUpdated: number;
  products: Record<string, RawProduct>;
}

export interface RawItem {
  id: string;
  name?: string;
  material?: string;
  tier?: string;
  category?: string;
  npc_sell_price?: number;
}

export interface RawItems {
  success: boolean;
  lastUpdated: number;
  items: RawItem[];
}
