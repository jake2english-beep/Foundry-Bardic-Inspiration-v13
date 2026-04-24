# Bardic Inspiration 2024 Inspired Condition

This module automates the 2024 Bardic Inspiration flow for Foundry VTT v13 and the official `dnd5e` system.

## What It Does

- Detects Bardic Inspiration item usage from the dnd5e activity workflow.
- Falls back to chat-message detection for item cards/messages named `Bardic Inspiration`.
- Applies an `Inspired` Active Effect to the chosen target.
- Stores the source bard, bardic die, application time, and usage state in `flags.bi2024`.
- Prompts the owning player, or the GM if no owner is active, when the inspired actor makes a valid d20 roll.
- Rolls Bardic Inspiration on demand, posts the inspiration roll to chat, posts a follow-up total, and removes the effect.

## Supported Roll Types

- Attack rolls
- Saving throws
- Ability checks
- Skill checks

## Not Prompted By Default

- Damage rolls
- Healing rolls
- Tool-only rolls unless they are exposed by the system as ability checks
- Initiative rolls, unless the `Prompt On Initiative` setting is enabled
- Non-d20 rolls

## Installation

1. Create a folder in Foundry's `Data/modules` directory named `bi-2024-inspired-condition`.
2. Place the files from this module inside that folder.
3. Restart Foundry.
4. Enable the module in your world.
5. Target one token and use `Bardic Inspiration`.

## Settings

- `Replace Existing Inspiration`: Replace an existing Inspired effect instead of refusing a second one.
- `Allow Multiple Targets`: Let one use apply to every current target.
- `Allow Self Inspiration`: Allow a bard to inspire themselves if explicitly targeted.
- `Prompt Only On Known Failed Rolls`: Skip the prompt when the module can confidently detect success.
- `Prompt On Initiative`: Allow initiative rolls to prompt when identifiable.
- `Debug Logging`: Print extra diagnostics to the browser console.

## Manual API / Macro

The module exposes:

```js
const api = game.modules.get("bi-2024-inspired-condition").api;

api.applyBardicInspiration(sourceActor, targetTokenOrActor);
api.removeBardicInspiration(targetActor);
api.getBardicDie(actor);
api.hasBardicInspiration(actor);
api.promptUseInspiration(actor, {
  rollType: "Attack Roll",
  total: 14
});
```

Example macro:

```js
const bard = canvas.tokens.controlled[0]?.actor;
const target = Array.from(game.user.targets)[0];
if (!bard || !target) return ui.notifications.warn("Control a bard and target a creature first.");
await game.modules.get("bi-2024-inspired-condition").api.applyBardicInspiration(bard, target);
```

## Limitations

- The module does not automatically verify line of sight, hearing, or 60-foot range.
- Foundry chat data does not always expose a reliable DC or AC, so some prompts will appear on rolls whose success is unknown.
- The module creates a follow-up chat summary instead of rewriting the original d20 total.
- If another module heavily rewrites dnd5e chat cards, roll-type detection may need adjustment.

## Troubleshooting

- If inspiration is not applying, make sure a target is selected before using the Bardic Inspiration feature.
- If you do not see prompts, confirm the inspired actor has an active player owner or an active GM in the world.
- Turn on `Debug Logging` and check the browser console for `bi-2024-inspired-condition` messages.
- If you use custom Bardic Inspiration items, keep `Bardic Inspiration` in the item name or set the dnd5e identifier to `bardic-inspiration`.

## Compatibility Notes

- Built for Foundry VTT v13.
- Built for the official `dnd5e` system.
- Does not require Midi-QOL, DAE, or Times Up.
- Should coexist with Midi-QOL, DAE, and Times Up without depending on them.
