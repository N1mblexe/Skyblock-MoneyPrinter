// View registry + navigation model (owned by the lead; each view lives in its own folder).
import type { RouteId, View } from '../../types/contracts.ts';
import { createAhFlipView } from './ahflip/ahflipView.ts';
import { createBooksView } from './books/booksView.ts';
import { createCraftView } from './craft/craftView.ts';
import { createFlipView } from './flip/flipView.ts';
import { createForgeView } from './forge/forgeView.ts';
import { createFusionView } from './fusion/fusionView.ts';
import { createItemView } from './item/itemView.ts';
import { createNpcView } from './npc/npcView.ts';
import { createOverviewView } from './overview/overviewView.ts';
import { createPlanView } from './plan/planView.ts';
import { createSellView } from './sell/sellView.ts';
import { createWatchView } from './watch/watchView.ts';

export const views: Record<RouteId, () => View> = {
  overview: createOverviewView,
  flip: createFlipView,
  ahflip: createAhFlipView,
  craft: createCraftView,
  forge: createForgeView,
  books: createBooksView,
  npc: createNpcView,
  fusion: createFusionView,
  plan: createPlanView,
  sell: createSellView,
  watch: createWatchView,
  item: createItemView,
};

export type NavGroup = 'markets' | 'production' | 'trade' | 'tools';

export interface NavEntry {
  id: Exclude<RouteId, 'item'>;
  group: NavGroup;
  /** label key: common.nav_<id> */
}

/** Sidebar / bottom-nav entries, in order. 'item' is reached via links and the palette only. */
export const NAV: NavEntry[] = [
  { id: 'overview', group: 'markets' },
  { id: 'flip', group: 'markets' },
  { id: 'books', group: 'markets' },
  { id: 'ahflip', group: 'markets' },
  { id: 'craft', group: 'production' },
  { id: 'forge', group: 'production' },
  { id: 'fusion', group: 'production' },
  { id: 'npc', group: 'trade' },
  { id: 'plan', group: 'tools' },
  { id: 'sell', group: 'tools' },
  { id: 'watch', group: 'tools' },
];
