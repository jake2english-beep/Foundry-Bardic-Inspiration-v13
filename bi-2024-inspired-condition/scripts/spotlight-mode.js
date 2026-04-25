const MODULE_ID = "spotlight-mode";
const SCENE_FLAG = "activeSpotlightTokenId";
const TOOL_NAME = "toggleSpotlight";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Spotlight Mode`);

  game.settings.register(MODULE_ID, "dimOpacity", {
    name: game.i18n.localize(`${MODULE_ID}.settings.dimOpacity.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.dimOpacity.hint`),
    scope: "client",
    config: true,
    type: Number,
    range: {
      min: 0.05,
      max: 1,
      step: 0.05
    },
    default: 0.2,
    onChange: refreshSpotlightState
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls.find((control) => control.name === "token");
  if (!tokenControls) return;

  tokenControls.tools.push({
    name: TOOL_NAME,
    title: game.i18n.localize(`${MODULE_ID}.controls.toggleSpotlight`),
    icon: "fa-solid fa-lightbulb",
    toggle: true,
    active: Boolean(getActiveSpotlightTokenId()),
    button: false,
    visible: game.user.isGM,
    onClick: async (toggled) => {
      if (toggled) {
        await activateSpotlightForSelection();
        return;
      }

      await clearSpotlight();
    }
  });
});

Hooks.on("canvasReady", refreshSpotlightState);
Hooks.on("controlToken", async (token, controlled) => {
  if (!controlled) return;
  if (game.user.isGM && getActiveSpotlightTokenId() && token.document.id !== getActiveSpotlightTokenId()) {
    await canvas.scene?.setFlag(MODULE_ID, SCENE_FLAG, token.document.id);
    return;
  }

  refreshSceneControls();
});
Hooks.on("updateScene", (scene, changed) => {
  if (scene.id !== canvas.scene?.id) return;
  if (!foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${SCENE_FLAG}`)) return;
  refreshSpotlightState();
  refreshSceneControls();
});
Hooks.on("deleteToken", (tokenDocument) => {
  if (tokenDocument.id !== getActiveSpotlightTokenId()) return;
  clearSpotlight();
});

async function activateSpotlightForSelection() {
  const token = canvas.tokens?.controlled[0];
  if (!token) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.selectToken`));
    refreshSceneControls();
    return;
  }

  await canvas.scene?.setFlag(MODULE_ID, SCENE_FLAG, token.document.id);
}

async function clearSpotlight() {
  if (!canvas.scene) return;
  await canvas.scene.unsetFlag(MODULE_ID, SCENE_FLAG);
}

function getActiveSpotlightTokenId() {
  return canvas.scene?.getFlag(MODULE_ID, SCENE_FLAG) ?? null;
}

function refreshSpotlightState() {
  const activeTokenId = getActiveSpotlightTokenId();
  const dimOpacity = Number(game.settings.get(MODULE_ID, "dimOpacity")) || 0.2;
  document.body.classList.toggle("spotlight-mode-active", Boolean(activeTokenId));

  for (const token of canvas.tokens?.placeables ?? []) {
    const isSpotlit = token.document.id === activeTokenId;
    const isActive = Boolean(activeTokenId);

    if (token.mesh) token.mesh.alpha = isActive && !isSpotlit ? dimOpacity : 1;
    if (token.border) token.border.visible = isSpotlit;
    token.renderFlags.set({ refreshState: true });
  }
}

function refreshSceneControls() {
  ui.controls?.initialize({ layer: "tokens" });
}
