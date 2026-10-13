// Final view registry (Wave 0). Do not edit in Wave 2; each view lives in its own folder.
import type { RouteId, View } from '../../types/contracts.ts';
import { createFlipView } from './flip/flipView.ts';
import { createCraftView } from './craft/craftView.ts';
import { createFusionView } from './fusion/fusionView.ts';
import { createItemView } from './item/itemView.ts';
import { createNpcView } from './npc/npcView.ts';

export const views: Record<RouteId, () => View> = {
  flip: createFlipView,
  craft: createCraftView,
  fusion: createFusionView,
  item: createItemView,
  npc: createNpcView,
};

/** Tabs shown in the nav, in order. 'item' is reached via links only. */
export const TAB_ORDER: RouteId[] = ['flip', 'craft', 'fusion', 'npc'];
