// Forge page (#/forge): forge recipes with durations and forge-slot limits. Same table, filters and detail panel
// as the Craft page's Recipes tab (createRecipesPane), with its own URL state and saved filters.
import type { View } from '../../../types/contracts.ts';
import { createRecipesPane } from '../craft/craftView.ts';

export const createForgeView = (): View => createRecipesPane('forge');
