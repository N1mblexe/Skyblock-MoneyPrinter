// English: the source language. Every other locale must have exactly these namespaces and keys (checked by the type below).
import { common } from './common.ts';
import { err } from './err.ts';
import { shell } from './shell.ts';
import { kit } from './kit.ts';
import { ahflip } from './ahflip.ts';
import { alerts } from './alerts.ts';
import { risk } from './risk.ts';
import { flip } from './flip.ts';
import { books } from './books.ts';
import { craft } from './craft.ts';
import { fusion } from './fusion.ts';
import { item } from './item.ts';
import { npc } from './npc.ts';
import { overview } from './overview.ts';
import { plan } from './plan.ts';
import { watch } from './watch.ts';

export const en = { common, err, ahflip, shell, kit, alerts, risk, flip, books, craft, fusion, item, npc, overview, plan, watch };

/** Shape every locale must match: same namespaces, same keys, string values. */
export type Messages = { [N in keyof typeof en]: Record<keyof (typeof en)[N], string> };
